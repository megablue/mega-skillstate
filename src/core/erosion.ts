/**
 * Payload erosion: trim the content the live turn has stopped needing.
 *
 * The collapse bounds a session by *message count* — turns, not tokens — so a
 * payload can be perfectly collapsed and still enormous. A live `/skillstate
 * now` printed `context 417369 -> 458371 tokens` on a pass that folded nothing:
 * the report was right, the mechanism was working, and the payload was still
 * huge. Decomposing that session from the database showed where the bytes were:
 * the kept window is not the tool results a synthetic probe suggests, it is the
 * model's own `skill_state` patch bodies, the reasoning it is not given back
 * verbatim, the arguments of the calls it made, and the results those calls
 * returned — in roughly that order of share.
 *
 * This module carries the two cuts that are *content-only* and therefore safe
 * against every rule the collapse obeys:
 *
 * 1. **Patch folding.** A `skill_state` call's `state_patch` is redundant the
 *    moment Σ has absorbed it: the state message in this very payload already
 *    renders the merged result, and the call's own result says which keys moved.
 *    So an old turn's patch body is replaced by a marker naming the keys and the
 *    size of what was folded. The tool-call part, its id and its result are left
 *    exactly where they are, so the pairing arithmetic is untouched.
 * 2. **Result capping.** A tool *result* over the cap is replaced by its head and
 *    tail with an omission marker between them. Head and tail are kept together
 *    because the two ends of a result are what a reader checks first: a file
 *    read's header, and the last lines where a command's errors land. A glob
 *    result is exempt on purpose — the seed extracts its file list from one, so
 *    trimming one would change what Σ says.
 *
 * Both cuts share three properties, and they are load-bearing:
 *
 * - **The live turn is never touched.** The turn the newest user message opened
 *   is the step being taken; the working memory that produced it stays verbatim.
 * - **Idempotent by construction.** A folded patch is a string and the cut only
 *   rewrites plain objects, so a second pass over the same array cannot fold a
 *   marker; a capped value is already under the cap, so it cannot be capped
 *   again.
 * - **Content-only.** Messages are *replaced* with shallow clones carrying the
 *   rewritten parts — the originals, the durable transcript and the pairing all
 *   stay untouched, and nothing is inserted or removed, so the seed and the
 *   fold-span arithmetic always see the raw conversation.
 *
 * What is deliberately NOT here: reasoning. A reasoning part cannot be truncated
 * without severing a provider signature, and dropping it wholesale is the one
 * decision the roadmap holds open pending provider evidence. It is its own
 * lever with its own research, not a by-product of this pass.
 *
 * @module mega-skillstate/erosion
 */

import { isPlainObject } from "./schema.ts"
import { TOOL_NAME } from "./skill-state.ts"
import { turnMap, viewOf } from "./view.ts"
import type { Message, ToolCallPart, ToolResultPart } from "./types.ts"
import type { StateRecord } from "./state.ts"

/** What the pass did, in the numbers the report and the log want. */
export interface ErosionReport {
  /** Skill-state patch bodies replaced by markers. */
  readonly foldedPatches: number
  /** Tool results capped, and the bytes that saved. */
  readonly cappedResults: number
  readonly bytesFreed: number
}

/** Nothing was touched. */
export const NO_EROSION: ErosionReport = { foldedPatches: 0, cappedResults: 0, bytesFreed: 0 }

/**
 * The turn no cut may touch: the one the newest user message opened.
 *
 * `turnMap` is idempotent per message id, so calling it here over the final
 * payload returns the same numbers the transform already assigned — the Σ
 * message it inserted carries an injected id, which numbers as the current turn
 * and is therefore protected along with the rest of the live tail.
 */
function liveTurn(messages: ReadonlyArray<Message>, record: StateRecord): number {
  const view = viewOf(messages)
  const turns = turnMap(view, record)
  return turns[view.length - 1] ?? 0
}

/** One tool call's arguments, as a plain object or nothing. */
function argumentsOf(part: ToolCallPart): Record<string, unknown> | undefined {
  const input = (part as { input?: unknown }).input
  return isPlainObject(input) ? (input as Record<string, unknown>) : undefined
}

/** The string value of a tool result, when it has one. */
function valueOf(part: ToolResultPart): string | undefined {
  const value = (part as { result?: { value?: unknown } }).result?.value
  return typeof value === "string" ? value : undefined
}

/** JSON size of a value, without throwing on something circular. */
function safeBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return typeof text === "string" ? text.length : 0
  } catch {
    return 0
  }
}

/**
 * The marker a folded patch body carries.
 *
 * It names what was folded and how big it was, because a model that cannot see
 * what it wrote needs to know that something *was* written: "nothing was
 * omitted" is only ever true when no marker is present.
 */
export function foldedPatchMarker(keys: ReadonlyArray<string>, bytes: number): string {
  const listed = keys.slice(0, 4).join(", ")
  const more = keys.length > 4 ? ", ..." : ""
  return "(folded into Sigma) " + listed + more + " (" + bytes + " bytes)"
}

/**
 * The text of a capped result: the head, the omission marker, and the tail.
 *
 * The marker is charged to the budget, so a capped value is never longer than
 * the cap allows — which is what makes a second pass over it a no-op.
 */
export function cappedResultText(value: string, budget: number): string {
  // The marker is charged to the budget, so a capped value is never longer than
  // the cap allows, and a second pass over it is a no-op. The count it carries
  // is sized from an upper bound, so the marker that actually ships is never
  // longer than the one the budget was sized for.
  const placeholder = "\n[... omitted " + String(value.length).length + " chars ...]\n"
  const room = Math.max(0, budget - placeholder.length)
  if (room <= 1) return value.slice(0, budget)
  const head = Math.floor(room / 2)
  const tail = value.slice(value.length - (room - head))
  const omitted = value.length - head - tail.length
  return head + "\n[... omitted " + omitted + " chars ...]\n" + tail
}

/** Fold every old turn's patch bodies into markers, counting what it did. */
function foldPatches(
  messages: ReadonlyArray<Message>,
  live: number,
  record: StateRecord,
): { messages: Message[]; folded: number } {
  const turns = turnMap(viewOf(messages), record)
  let folded = 0
  const out: Array<Message> = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const parts = message.content ?? []
    let content: Array<Message["content"][number]> | undefined
    if (turns[index] >= live) {
      out.push(message)
      continue
    }
    for (let position = 0; position < parts.length; position += 1) {
      const part = parts[position]
      if (part.type !== "tool-call") continue
      const call = part as ToolCallPart
      if (call.name !== TOOL_NAME) continue
      const args = argumentsOf(call)
      if (args === undefined) continue
      const patch = args["state_patch"]
      if (!isPlainObject(patch)) continue
      // A shallow clone: every other argument — step, summary — is left as it
      // was, and the original object is never written through.
      const keys = Object.keys(patch)
      const next: ToolCallPart = {
        ...call,
        input: { ...args, state_patch: foldedPatchMarker(keys, safeBytes(patch)) },
      }
      if (content === undefined) content = parts.slice()
      content[position] = next
      folded += 1
    }
    out.push(content === undefined ? message : { ...message, content })
  }
  return { messages: out, folded }
}

/** Cap every old turn's oversized results, counting what it did. */
function capResults(
  messages: ReadonlyArray<Message>,
  live: number,
  record: StateRecord,
  budget: number,
): { messages: Message[]; capped: number; freed: number } {
  const turns = turnMap(viewOf(messages), record)
  let capped = 0
  let freed = 0
  const out: Array<Message> = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const parts = message.content ?? []
    let content: Array<Message["content"][number]> | undefined
    if (turns[index] >= live) {
      out.push(message)
      continue
    }
    for (let position = 0; position < parts.length; position += 1) {
      const part = parts[position]
      if (part.type !== "tool-result") continue
      const result = part as ToolResultPart
      const value = valueOf(result)
      if (value === undefined || value.length <= budget) continue
      const text = cappedResultText(value, budget)
      const next: ToolResultPart = {
        ...result,
        result: { ...result.result, value: text },
      }
      if (content === undefined) content = parts.slice()
      content[position] = next
      capped += 1
      freed += value.length - text.length
    }
    out.push(content === undefined ? message : { ...message, content })
  }
  return { messages: out, capped, freed }
}

/**
 * The pass over one payload.
 *
 * @param messages - the payload as it stands *after* the collapse, so the live
 *   turn and the kept window are the array this pass will ship.
 * @param record - the session record, whose turn numbering decides which turns
 *   are live. It is read, never written.
 * @returns the (possibly replaced) array, and what the pass did.
 */
export function erode(
  messages: ReadonlyArray<Message>,
  record: StateRecord,
  options: { readonly foldPatchInputs: boolean; readonly maxResultChars: number },
): { messages: Array<Message>; report: ErosionReport } {
  if (options.foldPatchInputs !== true && options.maxResultChars <= 0) {
    return { messages: [...messages], report: NO_EROSION }
  }
  // One boundary, both cuts: the turn the newest user message opened.
  const live = liveTurn(messages, record)
  let current = messages
  let folded = 0
  let capped = 0
  let freed = 0
  if (options.foldPatchInputs === true) {
    const step = foldPatches(current, live, record)
    current = step.messages
    folded = step.folded
  }
  if (options.maxResultChars > 0) {
    const step = capResults(current, live, record, options.maxResultChars)
    current = step.messages
    capped = step.capped
    freed += step.freed
  }
  return { messages: [...current], report: { foldedPatches: folded, cappedResults: capped, bytesFreed: freed } }
}

/**
 * The note the report carries, when the pass did anything.
 *
 * It is absent when nothing was touched, because a note is a claim: the live
 * command prints them, and "folded 0" would be noise that reads as a decision.
 */
export function erosionNote(report: ErosionReport): string | undefined {
  const parts: string[] = []
  if (report.foldedPatches > 0) {
    parts.push("folded " + report.foldedPatches + " old patch input(s) into markers")
  }
  if (report.cappedResults > 0) {
    parts.push("capped " + report.cappedResults + " old result(s), saving " + report.bytesFreed + " chars")
  }
  return parts.length === 0 ? undefined : parts.join("; ")
}
