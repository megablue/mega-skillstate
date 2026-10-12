/**
 * The six ports every host adapter implements.
 *
 * Phase 1 *declares* them. The OpenCode adapter already satisfies the collapse,
 * storage, tool and command ones inline in its own modules (`src/adapters/
 * opencode/`), and making them explicit named implementations is the work
 * Phase 2 (Pi) and Phase 3 (the proxy daemon) do — the port list is the
 * checklist a new adapter works through, and the thing that keeps `src/core/`
 * from growing a host conditional.
 *
 * Two rules hold across all six:
 *
 * - A port is a **decision** interface, not a convenience bag: the core asks a
 *   port for a value or an action and never learns which host answered.
 * - Nothing crossing a port is a live object from a request. Values are plain
 *   data, so a restart or a second process sees the same thing.
 *
 * @module mega-skillstate/ports
 */

import type { CollapsedSpan, Message } from "./types.ts"
import type { Sigma } from "./schema.ts"

/** What every registration hands back; disposing it unregisters. */
export interface Disposable {
  dispose(): Promise<void> | void
}

/**
 * 1. The durable store: one session's Σ, the span it has collapsed, and the
 *    model's own note.
 *
 * Keys are plain strings and values are plain JSON. A host with no storage seam
 * simply provides no implementation and the core degrades to memory — a mode,
 * not a failure.
 *
 * This is the one port that is load-bearing from line one: `core/types.ts`
 * aliases `StorageDomain` to it, so the KV shape has exactly one definition and
 * the fake host in the smoke test satisfies it structurally.
 */
export interface Storage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove?(key: string): Promise<void>
  scan?(options: unknown): Promise<unknown>
}

/**
 * 2. How a collapsed span reaches the model.
 *
 * `request-rewrite` rewrites the outbound payload before the provider call
 * (OpenCode, Pi, the proxy): the durable transcript is never touched and every
 * request re-derives the payload from scratch, which is what makes a pass
 * idempotent by construction.
 *
 * `surface-replacement` records a replacement op in the host's own durable
 * surface (DeepSeek Harness): the same invariant, enforced by the host's fold
 * rather than by a plugin, and replayed deterministically on resume.
 *
 * Both collapse the same span into the same Σ. The `render` member is the seam
 * they share — it is `prompts.stateMessageText`, and a strategy that rendered
 * differently would be a strategy that disagreed with the collapse.
 */
export interface CollapseStrategy {
  readonly kind: "request-rewrite" | "surface-replacement"
  /** Σ plus the span, as the one message the model reads. */
  render(state: Sigma, span: CollapsedSpan | undefined): string
}

/**
 * 3. Host parts ↔ core vocabulary.
 *
 * The core only ever sees `Message` / `ContentPart` from `./types.ts`. A host
 * that spells a tool result differently — Anthropic `tool_result`, OpenAI
 * `function_call_output`, Pi's own part shapes — is decoded here on the way in
 * and re-encoded on the way out, so the collapse arithmetic is written once
 * against the core vocabulary and nowhere else.
 *
 * `strip` / `restore` exist because some hosts wrap content the core must not
 * read but must preserve byte for byte.
 */
export interface Codec {
  /** What came off the host's wire, as core messages. */
  decode(host: unknown): ReadonlyArray<Message>
  /** Core messages, as this host wants to send them. */
  encode(messages: ReadonlyArray<Message>): unknown
}

/**
 * 4. Register a tool the model can call.
 *
 * The definition is plain data plus a handler, because the core's `skill_state`
 * semantics (the `⊕` patch, the step, the ack) are host-free: only the envelope
 * the host wants around them is not. A host that cannot register a tool at all
 * is a host the core runs without its write channel, and Σ degrades to seeding.
 */
export interface ToolBridge {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly input: unknown
    readonly output?: unknown
    readonly options?: Readonly<Record<string, unknown>>
    execute(input: unknown, context: unknown): Promise<unknown>
  }): Promise<Disposable>
}

/**
 * 5. Register a command and a channel to answer the user on.
 *
 * `/skillstate` prints the context the transform measured and forces a collapse
 * on demand; both need a way back to the user that is not a tool result, which
 * is the whole of this port.
 */
export interface CommandBridge {
  register(definition: {
    readonly name: string
    readonly description?: string
    execute(invocation: unknown): Promise<void>
  }): Promise<Disposable>
}

/**
 * 6. Session identity, lifecycle, and the question the transform asks first.
 *
 * A session id is how Σ is addressed, and the parentage question decides
 * whether a child agent's conversation is managed at all. Both are host facts
 * the core reads through this port and never caches a host handle to reach.
 */
export interface SessionLifecycle {
  /** The session this request belongs to, or `undefined` when the host did not say. */
  sessionId(event: unknown): string | undefined
  /** Is this session a child agent's own conversation? */
  isChild(sessionID: string): Promise<boolean>
}
