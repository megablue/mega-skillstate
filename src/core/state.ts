/**
 * The per-session Σ store: what the model has committed, plus the bookkeeping the
 * transform carries between two requests.
 *
 * Two tiers, and the order between them is the point:
 *
 * 1. **The durable store** (`ctx.storage`, key `state/<sessionID>`) holds Σ, the span it
 *    has collapsed, and the note the model wrote. This is what makes Σ an execution
 *    state rather than a cache: a restart re-reads it and the work continues, instead of
 *    the context re-expanding to what the model originally saw.
 * 2. **The in-memory record** is a write-through cache in front of it. It holds the live
 *    object the pass reads and rewrites, the turn numbering this session has issued, and
 *    the step counter — all of which are per-request bookkeeping that would otherwise
 *    grow the KV without bound.
 *
 * Every mutation persists, and the `⊕` merge itself stays synchronous: load, merge,
 * persist. The base is never mutated in place by a merge — a new object is produced — so
 * a failed write leaves the state the pass is holding consistent with the last one that
 * succeeded.
 *
 * A record is addressed by session id and evicted least-recently-used, because a
 * long-lived server outlives its sessions and an unbounded map is a leak.
 *
 * **Degradation is not a failure mode, it is a mode.** A store that is absent, refuses a
 * key, or hands back something malformed leaves the plugin running in memory: a session
 * loses its Σ across a restart, which is exactly what it did before the store existed.
 * What it must never do is throw, because a turn that breaks is worse than a state that
 * has to be rebuilt.
 *
 * @module mega-skillstate/state
 */

import { changedKeys, merge, validateKeys, type Sigma } from "./schema.ts"
import type { CollapsedSpan, StorageDomain } from "./types.ts"

/** What the durable store holds for one session. */
export interface PersistedState {
  /** Σ as the model last committed it. */
  readonly state: Sigma
  /** The turns this session has already collapsed into Σ. */
  readonly collapsed: CollapsedSpan | undefined
  /** The model's own one-line note about the last write. */
  readonly summary: string | undefined
}

/** What the store is allowed to reach outside itself. */
export interface StoreDeps {
  /** The host's plugin-scoped KV; absent means in-memory only. */
  readonly storage?: StorageDomain
  /** Where a degraded store says so, when the configuration wants to hear it. */
  readonly log?: (line: string) => void
}

/** Everything this plugin remembers about one session. */
export interface StateRecord {
  readonly id: string
  /** The current Σ, exactly as the model last committed it. */
  get(): Sigma
  /** Replace Σ wholesale; keys the schema does not own are dropped. */
  set(next: Sigma): Promise<void>
  /** `⊕` a patch into Σ. @returns the keys that actually changed, in schema order. */
  apply(patch: unknown): Promise<string[]>
  /**
   * Fill keys the model has not written yet.
   *
   * A seeded value is a floor, never an override: the model's own account wins over
   * anything the deterministic seed could infer from the recent window, because the
   * model is the only thing here that knows *why*.
   *
   * @returns whether anything was actually filled, so a caller can skip a pointless write.
   */
  seed(partial: Sigma): Promise<boolean>
  /** The step index this session is on: `Σ.step`, or 0 until something has set it. */
  step(): number
  /** The turns this session has already collapsed into Σ, once it has collapsed. */
  collapsed(): CollapsedSpan | undefined
  /**
   * Record the span the last collapse replaced.
   *
   * The collapse is a commitment, not a one-off: it is what lets a later pass put Σ back
   * in exactly the same place, carrying the same span, so the payload is the same bytes
   * on every request rather than drifting with each pass. It survives a restart, because
   * a session that re-expands would be a session that lost its own account.
   */
  setCollapsed(span: CollapsedSpan | undefined): Promise<void>
  /** The model's own one-line note about the last write, if it wrote one. */
  summary(): string | undefined
  /** Carry the model's one-line note with the state. */
  setSummary(summary: string | undefined): Promise<void>
  /** Whether this record came from the durable store rather than starting empty. */
  readonly hydrated: boolean
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

/** The durable key one session's state lives under. */
export function stateKey(sessionID: string): string {
  return "state/" + sessionID
}

function createRecord(id: string, deps: StoreDeps, loaded: PersistedState | undefined): StateRecord {
  let state: Sigma = loaded === undefined ? {} : validateKeys(loaded.state)
  let span: CollapsedSpan | undefined = loaded?.collapsed
  let summary: string | undefined = loaded?.summary
  let stepsSinceUser = 0
  let lastUser: string | undefined
  const turns = new Map<string, number>()
  let highest = 0
  const storage = deps.storage
  const log = deps.log

  /**
   * Write through, and swallow.
   *
   * A refused key is a degraded store, not a broken turn: the note goes to the log when
   * the configuration asks for it, and the in-memory record carries on as the truth for
   * this process either way.
   */
  const persist = async (): Promise<void> => {
    if (storage === undefined) return
    const snapshot: PersistedState = { state, collapsed: span, summary }
    try {
      await storage.set(stateKey(id), snapshot)
    } catch (error) {
      log?.("the durable store refused state/" + id + ": " + (error instanceof Error ? error.message : String(error)))
    }
  }

  return {
    id,
    get: () => state,
    set: async (next) => {
      const before = state
      state = validateKeys(next)
      if (before !== state) await persist()
    },
    apply: async (patch) => {
      const before = state
      const next = merge(before, patch)
      state = next
      // `set` and `apply` both persist unconditionally: they are the model's own write,
      // and losing one to a store that said it accepted it is the failure that matters.
      await persist()
      return changedKeys(before, next)
    },
    seed: async (partial) => {
      // `state` is mutated in place rather than replaced, because seeding only ever
      // adds: nothing already there is touched, so nothing already rendered changes.
      let filled = false
      for (const key of Object.keys(partial)) {
        if (partial[key] === undefined) continue
        if (state[key] !== undefined) continue
        state[key] = partial[key]
        filled = true
      }
      if (filled) await persist()
      return filled
    },
    step: () => {
      const value = state["step"]
      return typeof value === "number" && Number.isFinite(value) ? value : 0
    },
    collapsed: () => span,
    setCollapsed: async (next) => {
      span = next
      await persist()
    },
    summary: () => summary,
    setSummary: async (next) => {
      const cleaned = next === undefined || next.trim().length === 0 ? undefined : next.trim()
      if (cleaned === summary) return
      summary = cleaned
      await persist()
    },
    get hydrated() {
      return loaded !== undefined
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

/** Is this something the durable store could have written? */
function isPersisted(value: unknown): value is PersistedState {
  if (typeof value !== "object" || value === null) return false
  const state = (value as { state?: unknown }).state
  return typeof state === "object" && state !== null && !Array.isArray(state)
}

/** Read one session's persisted state, or `undefined` when there is nothing usable. */
async function load(deps: StoreDeps, sessionID: string): Promise<PersistedState | undefined> {
  if (deps.storage === undefined) return undefined
  try {
    const found = await deps.storage.get(stateKey(sessionID))
    if (found === undefined || found === null) return undefined
    if (!isPersisted(found)) {
      deps.log?.("the durable store handed back something that is not a state, so " + sessionID + " starts empty")
      return undefined
    }
    return found
  } catch (error) {
    // A store that will not answer is a store this process does not have. The session
    // runs in memory, which is the behaviour of every host without a storage seam.
    deps.log?.(
      "the durable store could not be read for " + sessionID + ": " + (error instanceof Error ? error.message : String(error)),
    )
    return undefined
  }
}

/**
 * The record for one session, created on first use.
 *
 * A cache hit is served from memory; a miss is filled from the durable store first, so a
 * restart lands on the same Σ rather than an empty one.
 *
 * @param sessionID - the session the request belongs to.
 * @param deps - the durable store, when the host has one.
 * @returns the record, brought to the most-recently-used end of the eviction order.
 */
export async function stateStore(sessionID: string, deps: StoreDeps = {}): Promise<StateRecord> {
  const existing = records.get(sessionID)
  if (existing !== undefined) {
    records.delete(sessionID)
    records.set(sessionID, existing)
    return existing
  }
  const loaded = await load(deps, sessionID)
  const made = createRecord(sessionID, deps, loaded)
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

/** Drop one session's memory; the next pass re-reads it from the durable store. */
export function forgetSession(sessionID: string): void {
  records.delete(sessionID)
}

/** How many sessions are held in memory; the eviction test reads it. */
export function stateCount(): number {
  return records.size
}

/** The whole in-memory tier, dropped — the smoke test's "restart". */
export function resetStateStore(): void {
  records.clear()
}
