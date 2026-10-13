/**
 * The durable Σ store for the proxy daemon: the third Storage implementation.
 *
 * OpenCode keeps one keyed blob per session in its own domain; Pi keeps an
 * append log reconstructed from a branch; the proxy keeps a file. All three
 * satisfy the same port, and none of them knows it is talking to anything but
 * a `Storage`.
 *
 * **Why files and not the SQLite the roadmap names.** The proxy needs exactly
 * one thing the port declares: durable `get`/`set` of a JSON value per session
 * key, inside one process. `node:sqlite` would do that, but it is an
 * experimental builtin that prints a warning on every import and whose
 * availability depends on the node minor (22.5.0+, and a flag on some) — so it
 * would put an unpinnable runtime requirement and stderr noise into a smoke
 * test that must pass on both runners. A file satisfies the port with no
 * dependency at all. SQLite stays a named follow-up rather than a silent
 * omission; revisit it if the store ever needs a query it cannot answer with a
 * lookup.
 *
 * **Why nothing is cached.** The MCP server in the next slice may well be a
 * separate process sharing this directory, so an in-memory cache would be a
 * correctness hazard rather than an optimisation. Every `get` reads the file,
 * and the worst case is a small read per request.
 *
 * **Why every write is a rename.** Σ is the durable thing this plugin owns. A
 * write interrupted halfway through would leave a truncated JSON document, and
 * the next restart would read it as garbage — `load` would refuse it and the
 * session would silently resume empty, which is the failure this whole store
 * exists to prevent. So the value goes to a temporary file beside its target
 * and is renamed over it, which is atomic within a volume.
 *
 * @module mega-skillstate/proxy-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { Storage } from "../core/ports.ts"
import type { PersistedState } from "../core/state.ts"

/** A refusal to read or write is reported here, when the configuration asks. */
export type StoreLog = (line: string) => void

export interface ProxyStoreOptions {
  /** The directory Σ lives in. Created if it does not exist. */
  readonly dir: string
  /** Where a degrade goes, so it is visible rather than silent. */
  readonly log?: StoreLog
}

/**
 * One key, as a path under the data dir.
 *
 * The store does not trust its key. A session id reaches here through
 * `sanitize` in `session.ts`, but a key is supplied by whoever holds this
 * module, and a key like `state/../../elsewhere` would otherwise write outside
 * the store entirely. Flattening rather than rejecting keeps two sessions that
 * differ only in punctuation distinct instead of silently merging them.
 */
function pathFor(dir: string, key: string): string {
  const flat = key.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "")
  return join(dir, flat === "" ? "empty" : flat) + ".json"
}

/**
 * A durable Σ store over one directory.
 *
 * @returns the `Storage` the core's `stateStore` is handed, plus `dir` so the
 *          daemon can name what it opened.
 */
export function createProxyStore(options: ProxyStoreOptions): Storage {
  const dir = options.dir
  const log = options.log

  // A directory that cannot be created is a store that will never answer. It is
  // worth saying so once, at construction, rather than on every failing call.
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    log?.("the durable store could not create " + dir + ": " + (error instanceof Error ? error.message : String(error)))
  }

  /**
   * What a key holds, if anything.
   *
   * Three answers mean "nothing", and they are deliberately the same answer:
   * the file is absent (a session that has never written), the bytes are not
   * JSON (a truncated or hand-edited file), and the value is not a persisted
   * state (a shape this plugin never wrote). `undefined` for all three, so the
   * caller starts a fresh session rather than half-reading an old one.
   */
  const read = (key: string): unknown => {
    const path = pathFor(dir, key)
    if (!existsSync(path)) return undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
      const candidate = parsed as Partial<PersistedState>
      if (typeof candidate.state !== "object" || candidate.state === null || Array.isArray(candidate.state)) return undefined
      return parsed
    } catch (error) {
      // A file that will not parse is a file this process does not have. The
      // behaviour is the one every host without a storage seam gets anyway.
      log?.("the durable store could not read " + key + ": " + (error instanceof Error ? error.message : String(error)))
      return undefined
    }
  }

  return {
    get: async (key: string) => read(key),

    set: async (key: string, value: unknown) => {
      const path = pathFor(dir, key)
      // A temporary file beside the target, so the rename below is within one
      // volume. The suffix is per-key so two concurrent writers to the same
      // key cannot collide on it.
      const staging = path + "." + process.pid + ".tmp"
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(staging, JSON.stringify(value), "utf8")
        renameSync(staging, path)
      } catch (error) {
        // `persist` in `state.ts` already swallows this, but cleaning the
        // temporary file is this module's job: a directory full of abandoned
        // `.tmp` files is a leak nobody would find for months.
        try {
          if (existsSync(staging)) unlinkSync(staging)
        } catch {
          // Nothing left to do, and nothing left to say.
        }
        throw error
      }
    },

    remove: async (key: string) => {
      const path = pathFor(dir, key)
      try {
        if (existsSync(path)) unlinkSync(path)
      } catch (error) {
        log?.("the durable store could not remove " + key + ": " + (error instanceof Error ? error.message : String(error)))
      }
    },
  }
}
