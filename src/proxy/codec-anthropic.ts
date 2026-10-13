/**
 * The Anthropic Messages API codec: the conversation array in, core vocabulary
 * out, and back again byte for byte.
 *
 * **Why this file exists.** The proxy rewrites an outbound request rather than a
 * transcript, so it needs the host's wire shapes translated into the vocabulary
 * the collapse arithmetic is written against (`src/core/types.ts`) and back. The
 * transform must never learn how Anthropic spells a tool call; this is the only
 * file that knows.
 *
 * **Why the round trip is exact.** Every part in the core vocabulary carries
 * `readonly [key: string]: any`, and `Message` does too. So a host's extra
 * fields — `cache_control`, `is_error`, message `metadata`, a `container` —
 * survive a decode untouched, provided the codec *spreads* the host part rather
 * than constructing a fresh one. A spread also keeps an existing key in its
 * original position, which matters because the smoke's byte-identity check
 * compares `JSON.stringify` output and key order is part of that. Rebuilding a
 * part as `{type, text, summary}` silently reorders it and fails the compare
 * even though the data is identical.
 *
 * The consequence, stated once: **spread, never construct.** Where a derived
 * key is genuinely new (`text` on a decoded thinking block, `id`/`name`/
 * `result` on a decoded tool_result) it is appended, and `encode` removes it
 * before restoring the host shape in place.
 *
 * What is deliberately *not* here: `system`. It sits outside the conversation
 * array, carries nothing to collapse or translate, and is the daemon's to
 * carry. If this module took the whole request body, `decode` could not return
 * a `ReadonlyArray<Message>` and the round trip could not be asserted at all.
 *
 * @module mega-skillstate/proxy-codec-anthropic
 */

import type { Codec } from "../core/ports.ts"
import type { ContentPart, Message, ToolResultValue } from "../core/types.ts"
import { INJECTED_ID_PREFIX } from "../core/view.ts"

/** Anything the host sent: the shapes are loose because the wire is loose. */
type HostValue = Record<string, any>

function isRecord(value: unknown): value is HostValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

// ---------------------------------------------------------------------------
// decode: the wire, as core vocabulary
// ---------------------------------------------------------------------------

/**
 * `tool_use_id` is what a result cites, but the core pairs by `name` as well,
 * so the names are collected in a first pass. Anthropic puts the name on the
 * call and not on the result, which is exactly the asymmetry a codec exists to
 * absorb.
 */
function toolNames(host: readonly unknown[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const message of host) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "tool_use") continue
      if (typeof part.id === "string" && typeof part.name === "string") names.set(part.id, part.name)
    }
  }
  return names
}

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

function decodePart(part: unknown, names: ReadonlyMap<string, string>): ContentPart {
  if (!isRecord(part)) return { type: "text", text: asText(part) }
  switch (part.type) {
    case "thinking":
      // The core reads a reasoning part's `text`. Anthropic spells the payload
      // `thinking`, so the derived key is appended and the original `thinking`
      // and `signature` stay in place for `encode` to restore.
      return { ...part, type: "reasoning", text: asText(part.thinking) }
    case "tool_use":
      return { ...part, type: "tool-call" }
    case "tool_result":
      return decodeToolResult(part, names)
    default:
      // Anything the vocabulary does not name — `server_tool_use`,
      // `web_search_tool_result` — is carried through as a copy, so it is
      // measured as nothing and preserved as itself.
      return { ...part, type: fixedType(part) }
  }
}

function decodeToolResult(part: HostValue, names: ReadonlyMap<string, string>): ContentPart {
  const id = asText(part.tool_use_id)
  const kind: ToolResultValue["type"] = part.is_error === true ? "error" : "text"
  return {
    ...part,
    type: "tool-result",
    id,
    name: names.get(id) ?? "",
    result: { type: kind, value: part.content },
  }
}

function decodeMessage(message: unknown, names: ReadonlyMap<string, string>): Message {
  const source: HostValue = isRecord(message) ? message : {}
  const content = Array.isArray(source.content) ? source.content : []
  return {
    ...source,
    role: typeof source.role === "string" ? source.role : "",
    content: content.map((part: unknown) => decodePart(part, names)),
  }
}

// ---------------------------------------------------------------------------
// encode: core vocabulary, as the wire
// ---------------------------------------------------------------------------

/**
 * A state marker id is this plugin's own and means nothing to a provider that
 * would reject a field it does not know. The durable transcript is not touched
 * by the transform, but the *outbound* payload must not carry our private ids.
 */
function dropInjectedId(item: HostValue): HostValue {
  if (typeof item.id === "string" && item.id.startsWith(INJECTED_ID_PREFIX)) delete item.id
  return item
}

function encodePart(part: unknown): HostValue {
  if (!isRecord(part)) return { type: "text", text: asText(part) }
  switch (part.type) {
    case "reasoning": {
      // The inverse of the thinking decode: drop the derived `text`, then put
      // `thinking` back in the key position it originally held.
      const { text, ...rest } = part
      return { ...rest, type: "thinking", thinking: asText(text) }
    }
    case "tool-call":
      return { ...part, type: "tool_use" }
    case "tool-result":
      return encodeToolResult(part)
    default:
      return { ...part }
  }
}

function encodeToolResult(part: HostValue): HostValue {
  const { id, name, result, ...rest } = part
  const encoded: HostValue = { ...rest, type: "tool_result", tool_use_id: id, content: isRecord(result) ? result.value : result }
  // `is_error` is a host flag, not core vocabulary: it rides along in `rest`, so
  // it only needs re-asserting when the failure arrived as a result kind alone.
  if (rest.is_error === undefined && isRecord(result) && result.type === "error") encoded.is_error = true
  return encoded
}

function encodeMessage(message: Message): HostValue {
  const source = message as HostValue
  const content = Array.isArray(source.content) ? source.content : []
  const encoded: HostValue = {
    ...source,
    role: typeof source.role === "string" ? source.role : "",
    content: content.map((part: unknown) => encodePart(part)),
  }
  return dropInjectedId(encoded)
}

// ---------------------------------------------------------------------------
// strip / restore: content the core must not read but must hand back
// ---------------------------------------------------------------------------

/**
 * Thinking blocks are provider-stateful: the core has no business reading them,
 * yet a request that drops them is a request Anthropic rejects on the next
 * turn. So they come out before the transform and go back in after it, and the
 * recorded positions are the only thing standing between the two.
 *
 * A message left with nothing is *kept* as an empty message rather than
 * dropped, so the indices the capture records stay meaningful.
 */
export function strip(host: unknown): { stripped: unknown; removed: readonly unknown[] } {
  if (!Array.isArray(host)) return { stripped: host, removed: [] }
  const removed: { message: number; index: number; part: HostValue }[] = []
  const stripped = host.map((message: unknown, messageIndex: number) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message
    const kept: unknown[] = []
    message.content.forEach((part: unknown, partIndex: number) => {
      if (isRecord(part) && part.type === "thinking") removed.push({ message: messageIndex, index: partIndex, part })
      else kept.push(part)
    })
    return { ...message, content: kept }
  })
  return { stripped, removed }
}

/**
 * Reinserts what `strip` took out. The insertion runs in reverse record order
 * so that a part's own index is still valid when it is put back, and an
 * out-of-range index is clamped rather than thrown — a proxy that crashed on
 * half-restored provenance would be worse than one that degraded.
 */
export function restore(host: unknown, removed: readonly unknown[]): unknown {
  if (!Array.isArray(host)) return host
  const messages: HostValue[] = host.map((message) => (isRecord(message) ? { ...message } : message))
  for (const entry of [...removed].reverse()) {
    if (!isRecord(entry)) continue
    const messageIndex = Number(entry.message)
    const partIndex = Number(entry.index)
    const message = messages[messageIndex]
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    const content: unknown[] = [...message.content]
    content.splice(Math.max(0, Math.min(partIndex, content.length)), 0, entry.part)
    message.content = content
  }
  return messages
}

// ---------------------------------------------------------------------------
// The port, satisfied
// ---------------------------------------------------------------------------

export function decode(host: unknown): ReadonlyArray<Message> {
  if (!Array.isArray(host)) return []
  const names = toolNames(host)
  return host.map((message: unknown) => decodeMessage(message, names))
}

export function encode(messages: ReadonlyArray<Message>): unknown {
  if (!Array.isArray(messages)) return []
  return messages.map((message) => encodeMessage(message))
}

export const codec: Codec = { decode, encode, strip, restore }
export default codec
