/**
 * The message vocabulary the core reasons about, and the two structural shapes it
 * hands across a port.
 *
 * Split from the host mirror (`src/adapters/opencode/types.ts`) so the transform,
 * the state store, the seed and the compaction seam speak one vocabulary and none
 * of them needs OpenCode: a second adapter reuses this file unchanged and brings
 * its own mirror. What is here is what the core *reads* — a message, a part, a
 * system part, a collapsed span, a compaction event — plus the two host-shaped
 * handles that are structurally defined rather than imported (`StorageDomain`,
 * `CompactionEvent`), because both are reached only as parameter types.
 *
 * **Why `any` appears at the boundary.** The host's values are Effect Schema
 * types: branded strings that are not plain `string`, and generic codecs that no
 * narrower local type can both accept and be accepted by. Every field that *comes
 * from the host* is therefore typed loosely here, and the types this plugin owns
 * (its config, its state, its messages) are strict.
 *
 * @module mega-skillstate/types
 */

import type { Storage } from "./ports.ts"

export interface TextPart {
  readonly type: "text"
  text: string
  readonly [key: string]: any
}

export interface ReasoningPart {
  readonly type: "reasoning"
  text: string
  readonly [key: string]: any
}

/** A call the model made. Matched to its result by `id`. */
export interface ToolCallPart {
  readonly type: "tool-call"
  readonly id: string
  readonly name: string
  input: any
  readonly [key: string]: any
}

/** What a tool handed back: a value, a rendered text, or a failure. */
export interface ToolResultValue {
  readonly type: "json" | "text" | "error" | "content"
  value: any
}

export interface ToolResultPart {
  readonly type: "tool-result"
  readonly id: string
  readonly name: string
  result: ToolResultValue
  readonly [key: string]: any
}

export type ContentPart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | ToolResultPart
  | { readonly type: string; readonly [key: string]: any }

export interface Message {
  readonly id?: string
  readonly role: string
  content: ContentPart[]
  /** Measured on a live payload: present and empty on a plain user message. */
  readonly metadata?: Record<string, unknown>
  readonly [key: string]: any
}

export interface SystemPart {
  readonly type: "text"
  text: string
  readonly [key: string]: any
}

// ---------------------------------------------------------------------------
// The durable store, and the compaction seam
// ---------------------------------------------------------------------------

/**
 * The plugin-scoped KV, as `ctx.storage` hands it over.
 *
 * The one port that is load-bearing from line one: it is `ports.Storage`,
 * declared once there and aliased here so the readers that already name it —
 * `state.ts`'s `StoreDeps`, the tool's options, the transform's deps — keep one
 * name while the shape keeps one definition.
 *
 * Values are JSON, so what this plugin puts through it is plain data — the state,
 * the span it has collapsed, the note the model wrote — and never a live object
 * from a request.
 */
export type StorageDomain = Storage

/**
 * The `compaction` event: the transcript the host is about to summarise, and the
 * result that replaces its own summarizer.
 *
 * Structural on purpose — `runCompaction` reads `sessionID` and `messages` and
 * assigns `result`, and no host module is imported to say so. Setting `result`
 * means the host persists that string as the compaction message and makes no
 * model call of its own. `messages` is readable and deliberately never written
 * to: this plugin owns the *content* of the summary, not the transcript it came
 * from.
 */
export interface CompactionEvent {
  readonly sessionID: any
  readonly model: any
  readonly agent: any
  readonly system: SystemPart[]
  readonly messages: Message[]
  readonly tools: Record<string, any>
  /** Set to use this compaction and skip the host's summary request. */
  result?: { readonly summary: string; readonly [key: string]: any }
  readonly [key: string]: any
}

// ---------------------------------------------------------------------------
// What this plugin owns
// ---------------------------------------------------------------------------

/**
 * Σ: the structured execution state.
 *
 * A flat dictionary whose keys the schema owns (`src/core/schema.ts`). The model
 * writes it through `skill_state`; the runtime validates every patch, because
 * the paper's own failure modes are a state that was overwritten or emptied by a
 * malformed patch.
 */
export type StateSchema = Record<string, unknown>

/** A turn span a collapse folded into Σ. */
export interface CollapsedSpan {
  readonly from: number
  readonly to: number
}

/** The request a `skill_state` call acts on: the payload the context hook last saw. */
export interface LastRequest {
  readonly model: unknown
  readonly system: ReadonlyArray<SystemPart>
  readonly messages: Message[]
}

/**
 * An error's message, without depending on it being an Error.
 *
 * It lives here rather than beside its first caller: the compaction seam (core)
 * and the transform (adapter) both need it, and core importing an adapter module
 * for a three-line helper would invert the layering. So it sits with the
 * vocabulary both sides already share.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
