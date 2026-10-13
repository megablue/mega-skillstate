/**
 * The Storage port, as Pi satisfies it.
 *
 * OpenCode's host hands a plugin a keyed KV blob and this plugin reads and writes it
 * directly. Pi has no such blob: it has `appendEntry`, a durable, append-only store that
 * is *excluded* from the model's context, and `getBranch()`, the ordered transcript a
 * session is rebuilt from on resume.
 *
 * So the port is satisfied by an append log rather than a key map. `set` appends;
 * `get` reads what the last append said. That is enough for this plugin's whole durable
 * surface — one `PersistedState` per session — and it is resume-safe by construction: on
 * `session_start` the branch is walked, the last `mega_state` entry is found, and the
 * record is rebuilt from it rather than started empty.
 *
 * Two things this buys that a KV blob does not. It is **branch-aware**: a branch fork
 * carries its own Σ, because the entries travel with the branch. And it is **auditable**:
 * a session's writes are a sequence, so a state that changed can be traced to the write
 * that changed it.
 *
 * Degradation is a mode, not a failure: a branch with no `mega_state` entry starts empty,
 * a malformed entry is ignored with a log line, and nothing here ever throws.
 *
 * @module mega-skillstate/adapters/pi/storage
 */

import { stateKey } from "../../core/state.ts"
import type { PersistedState } from "../../core/state.ts"
import type { PiStorage } from "./types.ts"

/** The custom entry type this plugin's durable state is stored under. */
export const STATE_ENTRY_TYPE = "mega_state"

/** What the Pi storage is allowed to reach. */
export interface PiStorageHooks {
  /** Append a durable entry, excluded from the model's context. */
  readonly appendEntry: (customType: string, data: unknown) => unknown
  /** The branch this session is carrying — the resume-safe source of durable reads. */
  readonly getBranch?: () => ReadonlyArray<unknown>
  /** Where a malformed entry says so, when the configuration wants to hear it. */
  readonly log?: (line: string) => void
}

/** Is this something this plugin could have appended? */
function isPiStateEntry(value: unknown): value is { data?: unknown; payload?: unknown; customType?: unknown; type?: unknown } {
  return typeof value === "object" && value !== null
}

/** The payload an appended entry carries, unter whatever name the host gave it. */
function entryPayload(entry: unknown): unknown {
  if (!isPiStateEntry(entry)) return undefined
  const data = (entry as { data?: unknown }).data
  if (data !== undefined) return data
  const payload = (entry as { payload?: unknown }).payload
  return payload
}

/** Is this entry one of ours? */
function isOurs(entry: unknown): boolean {
  if (!isPiStateEntry(entry)) return false
  const customType = (entry as { customType?: unknown }).customType
  if (customType === STATE_ENTRY_TYPE) return true
  const type = (entry as { type?: unknown }).type
  return type === STATE_ENTRY_TYPE
}

/** Is this a durable state payload this plugin could have written? */
function isPersisted(value: unknown): value is PersistedState {
  if (typeof value !== "object" || value === null) return false
  const state = (value as { state?: unknown }).state
  return typeof state === "object" && state !== null && !Array.isArray(state)
}

/**
 * Build the Storage port over Pi's append log.
 *
 * @param hooks - the two host calls, plus an optional log.
 * @returns the port, ready to hand to `stateStore`.
 */
export function createPiStorage(hooks: PiStorageHooks): PiStorage {
  /**
   * The last durable payload this session appended, in this process.
   *
   * A KV blob answers a read from its store; an append log answers it from what it last
   * wrote. Holding the value locally means a `get` never has to walk the branch, and it
   * also means a read is answered even before the branch has been walked this session.
   * The walk on `session_start` is what repairs this after a restart, so the two agree.
   */
  let last: unknown

  return {
    get: async (key: string): Promise<unknown> => {
      // One key, one value: every session keeps its Σ under `state/<sessionID>`, and this
      // process appends for exactly one session, so a read for any other key has nothing
      // to answer with — which is the same "no durable state yet" a KV blob reports.
      if (key !== stateKey("*") && !key.startsWith("state/")) return undefined
      return last
    },
    set: async (key: string, value: unknown): Promise<void> => {
      if (!isPersisted(value)) {
        hooks.log?.("refusing to append something that is not a durable state under " + key)
        return
      }
      last = value
      try {
        hooks.appendEntry(STATE_ENTRY_TYPE, value)
      } catch (error) {
        // A refused append degrades to in-memory, exactly as a KV blob that refuses a set
        // does: the in-process record stays the truth for this process either way.
        hooks.log?.(
          "the append log refused " + key + ": " + (error instanceof Error ? error.message : String(error)),
        )
      }
    },
    remove: async (key: string): Promise<void> => {
      // An append log has no delete. Clearing what this process believes is the closest
      // honest analogue, and a later walk of the branch re-reads whatever was appended.
      if (key.startsWith("state/")) last = undefined
    },
    scan: async (prefix: string): Promise<ReadonlyArray<[string, unknown]>> => {
      // Only this session's entry is ever in scope, so a scan answers about that one.
      if (!prefix.startsWith("state/")) return []
      return last === undefined ? [] : [[stateKey("*"), last]]
    },
  }
}

/**
 * Rebuild the durable state from the branch, and repair what this process believes.
 *
 * Called on `session_start`, because that is the moment the host hands an extension a
 * session that already exists — which is the only moment a resume can be detected. The
 * branch is walked in order and the last `mega_state` entry wins, so a session that wrote
 * five states before restarting lands on the fifth.
 *
 * @param storage - the port {@link createPiStorage} built.
 * @param branch - the branch, as `getBranch()` hands it over.
 * @returns the restored state, or `undefined` when the branch carries none.
 */
export function restoreFromBranch(
  storage: PiStorage,
  branch: ReadonlyArray<unknown>,
  log?: (line: string) => void,
): PersistedState | undefined {
  let found: PersistedState | undefined
  for (const entry of branch) {
    if (!isOurs(entry)) continue
    const payload = entryPayload(entry)
    if (payload === undefined || payload === null) continue
    if (!isPersisted(payload)) {
      log?.("the branch carries a mega_state entry that is not a state, so it was skipped")
      continue
    }
    found = payload
  }
  // Repair the process-local view so a `get` answers what the branch says, even before
  // this process has appended anything of its own.
  void storage.set(stateKey("*"), found ?? { state: {} })
  return found
}
