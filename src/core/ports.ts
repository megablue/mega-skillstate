/**
 * The six ports every host adapter implements.
 *
 * Phase 1 *declared* them. Two hosts now satisfy them: the OpenCode adapter
 * inline in its own modules (`src/adapters/opencode/`), and the Pi adapter over
 * its own seams (`src/adapters/pi/`). Storage is the clearest case of why the
 * list is worth having — the same `stateStore` call reads a keyed KV blob on one
 * host and an append log reconstructed from a branch on the other, and neither
 * knows it is talking to anything but a `Storage`.
 *
 * What was declared ahead of the evidence was wrong in three places, and commit
 * `2744efc`'s Phase-2 pass corrected them from measured host shapes rather than
 * from guesswork: `ToolBridge`/`CommandBridge` claimed a `Disposable` return that
 * only OpenCode actually produces, and `CollapseStrategy` had no member for the
 * one decision the two strategies genuinely differ on. The port list is the
 * checklist a new adapter works through, and the thing that keeps `src/core/`
 * from growing a host conditional — but a checklist written before anyone has
 * walked it is a guess, so it is corrected by evidence as each host lands.
 *
 * One entry-shape detail the Pi work settled, recorded here because the ROADMAP
 * had it wrong: an extension's entry point is a **default export** taking the
 * host's `ExtensionAPI` (`export default function (pi: ExtensionAPI)`), not a
 * named `activate`. A local-path install loads from the resolved path without
 * copying, so this repo is the Pi package and the manifest's `pi.extensions`
 * key is what points at that factory.
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
 *
 * `collapse` is the other half, and it is the part a declaration cannot leave
 * implicit: the two strategies above do *not* agree on how a span reaches the
 * payload. `request-rewrite` splices Σ into the message array in place; a
 * surface-based host instead records a replacement and lets its own fold apply
 * it. Both are correct, and choosing between them is exactly the decision a
 * strategy exists to hold — so it is a member rather than a comment.
 */
export interface CollapseStrategy {
  readonly kind: "request-rewrite" | "surface-replacement"
  /** Σ plus the span, as the one message the model reads. */
  render(state: Sigma, span: CollapsedSpan | undefined): string
  /**
   * Apply a span to a payload, or record it for the host's own fold.
   * @returns nothing, or the messages the host should send in place of them.
   */
  collapse(messages: ReadonlyArray<Message>, span: CollapsedSpan, state: Sigma): void | ReadonlyArray<Message>
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
 *
 * The `restore` contract is what makes a round trip exact, and it is the whole
 * reason this port can be tested without a live host: `encode(decode(host))`
 * must return the host value unchanged. That holds only if the codec never
 * *constructs* a part where it could have spread one — the vocabulary's index
 * signature (`readonly [key: string]: any` on every part) is what carries a
 * host's extra fields through a decode, and building a fresh `{type, text}`
 * silently drops them. A host that wraps nothing in the first place — Pi, whose
 * vocabulary already *is* the core's — returns its input from both members
 * unchanged.
 */
export interface Codec {
  /** What came off the host's wire, as core messages. */
  decode(host: unknown): ReadonlyArray<Message>
  /** Core messages, as this host wants to send them. */
  encode(messages: ReadonlyArray<Message>): unknown
  /**
   * Content the core must not read but must hand back untouched.
   * @returns the payload with opaque content removed, and what was removed.
   */
  strip(host: unknown): { readonly stripped: unknown; readonly removed: readonly unknown[] }
  /** Put opaque content back into a payload the core rewrote. */
  restore(host: unknown, removed: readonly unknown[]): unknown
}

/**
 * 4. Register a tool the model can call.
 *
 * The definition is plain data plus a handler, because the core's `skill_state`
 * semantics (the `⊕` patch, the step, the ack) are host-free: only the envelope
 * the host wants around them is not. A host that cannot register a tool at all
 * is a host the core runs without its write channel, and Σ degrades to seeding.
 *
 * The return is a `Disposable | undefined` on purpose, and the `undefined` is
 * not an omission: OpenCode's hooks hand back a registration that unregisters,
 * but Pi's `registerTool` and `registerCommand` return **void**, and the
 * two hosts' lifecycles differ further — a Pi factory is not handed a disposer
 * to call, and a proxy daemon registers at startup and never again. So the port
 * says what the core can rely on (a disposable when the host offers one) rather
 * than what one host happens to do.
 */
export interface ToolBridge {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly input: unknown
    readonly output?: unknown
    readonly options?: Readonly<Record<string, unknown>>
    execute(input: unknown, context: unknown): Promise<unknown>
  }): Promise<Disposable | undefined> | undefined
}

/**
 * 5. Register a command and a channel to answer the user on.
 *
 * `/skillstate` prints the context the transform measured and forces a collapse
 * on demand; both need a way back to the user that is not a tool result, which
 * is the whole of this port.
 *
 * The return follows {@link ToolBridge} for the same reason: a disposable when
 * the host offers one. OpenCode's `command.transform` hands one back; Pi's
 * `registerCommand` returns void.
 */
export interface CommandBridge {
  register(definition: {
    readonly name: string
    readonly description?: string
    execute(invocation: unknown): Promise<void>
  }): Promise<Disposable | undefined> | undefined
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
