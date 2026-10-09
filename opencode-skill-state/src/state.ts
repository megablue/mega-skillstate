/**
 * The per-session Σ store: what the model has committed, plus the bookkeeping the
 * transform carries between two requests.
 *
 * It is in memory on purpose. The durable transcript is never touched — the transform
 * rewrites the outbound payload and nothing else — so the worst a restart can do is
 * re-expand the context to what the model originally saw, with Σ empty and the recent
 * window still verbatim. That is a smaller failure than a written-down state that no
 * longer matches the conversation it claims to summarise.
 *
 * A record is addressed by session id and evicted least-recently-used, because a
 * long-lived server outlives its sessions and an unbounded map is a leak.
 *
 * @module opencode-skill-state/state
 */

import { changedKeys, merge, validateKeys, type Sigma } from "./schema.ts"
import type { CollapsedSpan } from "./types.ts"

/** Everything this plugin remembers about one session. */
export interface StateRecord {
  readonly id: string
  /** The current Σ, exactly as the model last committed it. */
  get(): Sigma
  /** Replace Σ wholesale; keys the schema does not own are dropped. */
  set(next: Sigma): void
  /** `⊕` a patch into Σ. @returns the keys that actually changed, in schema order. */
  apply(patch: unknown): string[]
  /** The step index this session is on: `Σ.step`, or 0 until something has set it. */
  step(): number
  /**
   * Fill keys the model has not written yet.
   *
   * A seeded value is a floor, never an override: the model's own account wins over
   * anything the deterministic seed could infer from the recent window, because the
   * model is the only thing here that knows *why*.
   */
  seed(partial: Sigma): void
  /** The step index this session is on. */
  step(): number
  /** The turns this session has already collapsed into Σ, once it has collapsed. */
  collapsed(): CollapsedSpan | undefined
  /**
   * Record the span the last collapse replaced.
   *
   * The collapse is a commitment, not a one-off: it is what lets a later pass put Σ back
   * in exactly the same place, carrying the same span, so the payload is the same bytes
   * on every request rather than drifting with each pass.
   */
  setCollapsed(span: CollapsedSpan | undefined): void
  /** The model's own one-line note about the last write, if it wrote one. */
  summary(): string | undefined
  /** Carry the model's one-line note with the state. */
  setSummary(summary: string | undefined): void
  /** Record which user message is newest, and how many passes it has been there. */
  observeUser(messageId: string | undefined): void
  /** Passes since the newest real user message changed. */
  readonly stepsSinceUser: number
  /** The id of the newest real user message this session has seen. */
  readonly lastUserMessageId: string | undefined
  /** The turn already assigned to a message id, if this session has seen it. */
  turnOf(messageId: string): number | undefined
  /** Record a turn for a message id, once. */
  assignTurn(messageId: string, turn: number): void
  /** The highest turn number this session has issued, or 0. */
  highestTurn(): number
}

/** How many sessions are remembered before the least recently used one is dropped. */
export const MAX_SESSIONS = 64

function createRecord(id: string): StateRecord {
  let state: Sigma = {}
  let span: CollapsedSpan | undefined
  let summary: string | undefined
  let stepsSinceUser = 0
  let lastUser: string | undefined
  const turns = new Map<string, number>()
  let highest = 0

  return {
    id,
    get: () => state,
    set: (next) => {
      state = validateKeys(next)
    },
    apply: (patch) => {
      const before = state
      const next = merge(before, patch)
      state = next
      return changedKeys(before, next)
    },
    seed: (partial) => {
      // `state` is mutated in place rather than replaced, because seeding only ever
      // adds: nothing already there is touched, so nothing already rendered changes.
      for (const key of Object.keys(partial)) {
        if (partial[key] === undefined) continue
        if (state[key] !== undefined) continue
        state[key] = partial[key]
      }
    },
    // The step lives in Σ, like every other key: the seed may have set it, a patch may
    // delete it, and the tool advances whatever is there rather than a private counter
    // that would quietly disagree with the state the model can read.
    step: () => {
      const value = state["step"]
      return typeof value === "number" && Number.isFinite(value) ? value : 0
    },
    collapsed: () => span,
    setCollapsed: (next) => {
      span = next
    },
    summary: () => summary,
    setSummary: (next) => {
      summary = next === undefined || next.trim().length === 0 ? undefined : next.trim()
    },
    observeUser: (messageId) => {
      if (messageId !== lastUser) {
        lastUser = messageId
        stepsSinceUser = 0
        return
      }
      // No new instruction, so this pass is another step of the same one: the stale
      // reminder is about exactly this distance.
      stepsSinceUser += 1
    },
    get stepsSinceUser() {
      return stepsSinceUser
    },
    get lastUserMessageId() {
      return lastUser
    },
    turnOf: (messageId) => turns.get(messageId),
    assignTurn: (messageId, turn) => {
      if (!turns.has(messageId)) turns.set(messageId, turn)
      if (turn > highest) highest = turn
    },
    highestTurn: () => highest,
  }
}

const records = new Map<string, StateRecord>()

/**
 * The record for one session, created on first use.
 *
 * @param sessionID - the session the request belongs to.
 * @returns the record, brought to the most-recently-used end of the eviction order.
 */
export function stateStore(sessionID: string): StateRecord {
  const existing = records.get(sessionID)
  if (existing !== undefined) {
    records.delete(sessionID)
    records.set(sessionID, existing)
    return existing
  }
  const made = createRecord(sessionID)
  records.set(sessionID, made)
  while (records.size > MAX_SESSIONS) {
    const oldest = records.keys().next().value
    if (oldest === undefined) break
    records.delete(oldest)
  }
  return made
}

/** The record for one session, when it already has one. */
export function stateOf(sessionID: string): StateRecord | undefined {
  return records.get(sessionID)
}

/** Drop one session's memory; the next pass starts it over. */
export function forgetSession(sessionID: string): void {
  records.delete(sessionID)
}

/** How many sessions are held; the eviction test reads it. */
export function stateCount(): number {
  return records.size
}
