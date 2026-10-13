/**
 * The OpenAI Responses API codec: the item list in, core vocabulary out, and
 * back again byte for byte.
 *
 * **Why this is not the Anthropic codec with renames.** Responses is a *flat*
 * item list, so its tool shapes are top-level items rather than content parts
 * inside a message. A one-to-one part mapping is therefore impossible, and the
 * decision below is the codec's whole content.
 *
 * Each top-level item becomes one core `Message`, and the item's own key order
 * *is* that message's key order. The spread happens at the message level, and
 * the core part is the core's own shape — which is the inverse of Anthropic,
 * where the parts themselves are the host's shapes. `encode` then walks the
 * message's own keys to rebuild the item, so the item's field order survives,
 * `role` (added by decode) is skipped, and the core's `content` array is
 * substituted back for whatever the item held there.
 *
 * The one place that matters most: `arguments` is a JSON *string* on the wire.
 * The core's `input` is `any`, so decode parses it — but `encode` must never
 * re-serialise it, because `JSON.stringify(JSON.parse(s))` is not `s` whenever
 * the original has whitespace. The raw string lives on the message and is
 * simply carried back.
 *
 * What is deliberately *not* here: `instructions`. It sits outside the item
 * list, carries nothing to collapse or translate, and is the daemon's to carry.
 *
 * @module mega-skillstate/proxy-codec-openai
 */

import type { Codec } from "../core/ports.ts"
import type { ContentPart, Message } from "../core/types.ts"
import { INJECTED_ID_PREFIX } from "../core/view.ts"

/** Anything the host sent: the shapes are loose because the wire is loose. */
type HostValue = Record<string, any>

function isRecord(value: unknown): value is HostValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * A `function_call` is keyed by `call_id` and its result by `call_id` too, so
 * that is the pairing key the core sees. The item's own `id` is a separate host
 * field that stays where it is.
 */
function callIdOf(item: HostValue): string {
  return typeof item.call_id === "string" ? item.call_id : asText(item.id)
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function summaryText(item: HostValue): string {
  const summary = item.summary
  if (!Array.isArray(summary)) return ""
  const texts: string[] = []
  for (const entry of summary) {
    if (isRecord(entry)) texts.push(asText(entry.text))
  }
  return texts.join("\n")
}

// ---------------------------------------------------------------------------
// decode: the wire, as core vocabulary
// ---------------------------------------------------------------------------

/**
 * `ContentPart`'s catch-all member wants a `type` that is *provably* a string,
 * and TS will not infer one through a `Record<string, any>` spread even though
 * the value always has it. Naming it here keeps the spread (unknown fields and
 * key order both depend on it) while satisfying the constraint. Because `type`
 * is already a key on the host part, restating it after the spread leaves it in
 * the position it originally held.
 */
function fixedType(part: HostValue): string {
  return typeof part.type === "string" ? part.type : String(part.type)
}

function callNames(host: readonly unknown[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const item of host) {
    if (!isRecord(item) || item.type !== "function_call") continue
    const id = callIdOf(item)
    if (id !== "" && typeof item.name === "string") names.set(id, item.name)
  }
  return names
}

function decodeTextPart(part: unknown): ContentPart {
  if (!isRecord(part)) return { type: "text", text: asText(part) }
  if (part.type === "input_text" || part.type === "output_text") return { ...part, type: "text" }
  return { ...part, type: fixedType(part) }
}

function decodeMessageItem(item: HostValue): Message {
  const content = Array.isArray(item.content) ? item.content : []
  return {
    ...item,
    role: typeof item.role === "string" ? item.role : "",
    content: content.map(decodeTextPart),
  }
}

function decodeItem(item: unknown, names: ReadonlyMap<string, string>): Message {
  const source: HostValue = isRecord(item) ? item : {}
  switch (source.type) {
    case "message":
      return decodeMessageItem(source)
    case "function_call": {
      // The part is typed as `ContentPart`, not `HostValue`: a `Record<string, any>`
      // has no visible `type`, and the catch-all member of the union needs one it
      // can prove is a string. A literal here carries the constraint directly.
      const part: ContentPart = {
        type: "tool-call",
        id: callIdOf(source),
        name: typeof source.name === "string" ? source.name : "",
        input: parseArguments(source.arguments),
      }
      return { ...source, role: "assistant", content: [part] }
    }
    case "function_call_output": {
      const id = callIdOf(source)
      const part: ContentPart = {
        type: "tool-result",
        id,
        name: names.get(id) ?? "",
        result: { type: "text", value: source.output },
      }
      return { ...source, role: "user", content: [part] }
    }
    case "reasoning": {
      // The item's own `content` blocks collide with the core's content array,
      // so they ride on the part under a private key and `encode` puts them
      // back at the position they came from.
      const part: ContentPart =
        source.content === undefined
          ? { type: "reasoning", text: summaryText(source) }
          : { type: "reasoning", text: summaryText(source), itemContent: source.content }
      return { ...source, role: "assistant", content: [part] }
    }
    default:
      // An item the vocabulary does not name (`web_search_call`) keeps its own
      // fields on the message and contributes no part, so the core measures it
      // as nothing and the host gets it back untouched.
      return { ...source, role: "assistant", content: [] }
  }
}

// ---------------------------------------------------------------------------
// encode: core vocabulary, as the wire
// ---------------------------------------------------------------------------

function dropInjectedId(item: HostValue): HostValue {
  if (typeof item.id === "string" && item.id.startsWith(INJECTED_ID_PREFIX)) delete item.id
  return item
}

function firstPart(content: readonly unknown[]): HostValue | undefined {
  const first = content[0]
  return isRecord(first) ? first : undefined
}

/**
 * Rebuilds a flat item by walking the message's own key order: `role` is
 * skipped because decode added it, and `content` — the key decode put the core
 * parts into — is replaced by whatever the item held there. Walking the keys
 * rather than spreading a literal is what preserves the item's field order.
 */
function flatItem(source: HostValue, content: readonly unknown[]): HostValue {
  const part = firstPart(content)
  const encoded: HostValue = {}
  for (const key of Object.keys(source)) {
    if (key === "role") continue
    if (key === "content") {
      if (part && part.itemContent !== undefined) encoded.content = part.itemContent
      continue
    }
    encoded[key] = source[key]
  }
  return dropInjectedId(encoded)
}

function encodeTextPart(part: unknown, role: unknown): HostValue {
  // Responses puts `output_text` on assistant items and `input_text` on
  // everything else, so the part type is derived from the message's role rather
  // than carried as a duplicate field.
  const hostType = role === "assistant" ? "output_text" : "input_text"
  if (!isRecord(part)) return { type: hostType, text: asText(part) }
  if (part.type !== "text") return { ...part }
  const { type: _kind, ...rest } = part
  return { type: hostType, ...rest }
}

function encodeItem(source: HostValue, itemType: string, content: readonly unknown[]): HostValue {
  return flatItem(source, content)
}

function encodeMessage(message: Message): HostValue {
  const source = message as HostValue
  const content = Array.isArray(source.content) ? source.content : []
  if (typeof source.type !== "string") {
    // A core-native message: the transform's Σ, or anything the core built. It
    // has no item type of its own, so it goes out as a plain message item.
    const encoded: HostValue = {
      type: "message",
      ...source,
      role: typeof source.role === "string" ? source.role : "",
      content: content.map((part: unknown) => encodeTextPart(part, source.role)),
    }
    return dropInjectedId(encoded)
  }
  switch (source.type) {
    case "message": {
      const encoded: HostValue = {
        ...source,
        role: typeof source.role === "string" ? source.role : "",
        content: content.map((part: unknown) => encodeTextPart(part, source.role)),
      }
      return dropInjectedId(encoded)
    }
    case "function_call": {
      const part = firstPart(content)
      const encoded = encodeItem(source, source.type, content)
      if (part) {
        encoded.call_id = part.id
        encoded.name = part.name
        // The raw string is already on the message, so it is carried back
        // verbatim; serialising is the fallback for a part nothing decoded.
        encoded.arguments =
          typeof source.arguments === "string" ? source.arguments : typeof part.arguments === "string" ? part.arguments : stringify(part.input)
      }
      return encoded
    }
    case "function_call_output": {
      const part = firstPart(content)
      const encoded = encodeItem(source, source.type, content)
      if (part) {
        encoded.call_id = part.id
        encoded.output = isRecord(part.result) ? part.result.value : part.result
      }
      return encoded
    }
    case "reasoning": {
      const part = firstPart(content)
      const encoded = encodeItem(source, source.type, content)
      if (part && part.itemContent === undefined && encoded.summary === undefined && asText(part.text) !== "") {
        encoded.summary = [{ type: "summary_text", text: part.text }]
      }
      return encoded
    }
    default:
      return encodeItem(source, source.type, content)
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return "{}"
  }
}

// ---------------------------------------------------------------------------
// strip / restore: content the core must not read but must hand back
// ---------------------------------------------------------------------------

/**
 * Reasoning items are provider state. The core must not read them, but a
 * request that drops them loses the model's own encrypted provenance and
 * Responses will not continue the conversation. They come out before the
 * transform and go back in after it.
 *
 * Only the *items* come out, so `encrypted_content` and the item's own field
 * order both survive; a message left with nothing is kept rather than dropped.
 */
export function strip(host: unknown): { stripped: unknown; removed: readonly unknown[] } {
  if (!Array.isArray(host)) return { stripped: host, removed: [] }
  const removed: { index: number; item: HostValue }[] = []
  const stripped: unknown[] = []
  host.forEach((item: unknown, index: number) => {
    if (isRecord(item) && item.type === "reasoning") removed.push({ index, item })
    else stripped.push(item)
  })
  return { stripped, removed }
}

/**
 * Reinserts in reverse record order so each recorded index is still valid when
 * it is used, and clamps rather than throws.
 */
export function restore(host: unknown, removed: readonly unknown[]): unknown {
  if (!Array.isArray(host)) return host
  const items: unknown[] = [...host]
  for (const entry of [...removed].reverse()) {
    if (!isRecord(entry)) continue
    const index = Number(entry.index)
    if (!Number.isInteger(index)) continue
    if (!isRecord(entry.item)) continue
    items.splice(Math.max(0, Math.min(index, items.length)), 0, entry.item)
  }
  return items
}

// ---------------------------------------------------------------------------
// The port, satisfied
// ---------------------------------------------------------------------------

export function decode(host: unknown): ReadonlyArray<Message> {
  if (!Array.isArray(host)) return []
  const names = callNames(host)
  return host.map((item: unknown) => decodeItem(item, names))
}

export function encode(messages: ReadonlyArray<Message>): unknown {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => encodeMessage(message))
}

export const codec: Codec = { decode, encode, strip, restore }
export default codec
