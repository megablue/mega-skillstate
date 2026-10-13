/**
 * mega-skillstate for Pi — the default-export factory.
 *
 * Four contributions, registered from one entry point, mirroring what the OpenCode
 * adapter contributes and differing only where this host differs:
 *
 * 1. a standing prompt section stating the policy — Σ is the record, and anything not
 *    written to it goes with the turn that knew it;
 * 2. a transform on every request's `context` event that injects Σ and collapses the
 *    superseded prefix into it, so the outbound payload is ≈ `P + Σ + recent window`;
 * 3. `skill_state`, the tool the model uses to write Σ: a dictionary merge the runtime
 *    validates, where a `null` deletes a key and an unknown key is dropped;
 * 4. `/skillstate`, the same context measured and printed, plus `now` to force a collapse.
 *
 * Nothing here edits the durable transcript: the transform rewrites the payload the host
 * is about to send, and it is re-derived on every request from the raw transcript and the
 * in-memory Σ. Cuts happen only at safe turn boundaries, so a `tool-call` is never
 * separated from its `tool-result`.
 *
 * The three places this host genuinely differs from OpenCode, all of them measured rather
 * than assumed:
 *
 * - **Storage.** Not a keyed blob but an append log: `appendEntry` writes, `getBranch()`
 *   reconstructs, and the reconstruction happens on `session_start` so a resumed session
 *   lands on the same Σ rather than an empty one.
 * - **The policy push.** Pi's `context` event carries no system array to append to, so the
 *   section is pushed through `before_agent_start`'s `systemPromptOptions` instead.
 * - **The command.** The argument is a string, and the reply is a `ctx.ui.notify` that does
 *   not trigger a turn — so the payload the command reports on has to be recorded by the
 *   pass, not read from a request that is in flight.
 *
 * @module mega-skillstate/adapters/pi
 */

import { resolveOptions, resolveConfig } from "../../core/config.ts"
import { messageOf } from "../../core/types.ts"
import type { LastRequest } from "../../core/types.ts"
import type { TransformDeps } from "../../core/context.ts"
import { MAX_SESSIONS } from "../../core/state.ts"
import { createPiSkillStateCommand } from "./command.ts"
import { registerPiContext } from "./context.ts"
import { createPiStorage, restoreFromBranch } from "./storage.ts"
import { createPiSkillState } from "./tool.ts"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext } from "./types.ts"

/**
 * The user-level config option path, in this host's own settings directory.
 *
 * The OpenCode adapter resolves this beside `opencode.json`; this host keeps its own
 * configuration elsewhere, and the plugin's file sits in that directory. Exported so a
 * test can pin where it reads, since a wrong directory reads a file that does not exist
 * and the merge then silently contributes nothing.
 */
export const PI_OPTIONS_PATH =
  process.env["MEGA_SKILLSTATE_PI_OPTIONS"] ?? joinHome(".config", "pi", "mega-skillstate.json")

function joinHome(...segments: string[]): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "."
  return [home, ...segments].join("/")
}

/**
 * Register what this plugin contributes. Pi awaits the factory, and ignores its return.
 *
 * @param pi - the host's extension API.
 */
export default function (pi: ExtensionAPI): void {
  const warn = (line: string): void => {
    try {
      console.error("[mega-skillstate] " + line)
    } catch {
      // A host without a console still gets the plugin's behaviour, not its notes.
    }
  }

  // A refused configuration is loud on purpose: a context policy that quietly keeps a
  // default is worse than one that refuses to load. The host's own entry has no place in
  // this host's shape that has been measured, so the layers here are the user file and the
  // shipped defaults; a discovered extension surface would be merged in front of them.
  const config = resolveConfig(resolveOptions(undefined, PI_OPTIONS_PATH))

  if (config.enabled !== true) return

  // The last request each session's context pass saw, bounded like the session state is.
  // Pi's command cannot read a request in flight — a `ctx.ui.notify` is not part of one —
  // so the pass records what it measured and the command answers from that.
  const payloads = new Map<string, LastRequest>()
  const remember = (sessionID: string, payload: LastRequest): void => {
    payloads.delete(sessionID)
    payloads.set(sessionID, payload)
    while (payloads.size > MAX_SESSIONS) {
      const oldest = payloads.keys().next().value
      if (oldest === undefined) break
      payloads.delete(oldest)
    }
  }

  const log = (line: string): void => {
    if (config.debug === true) warn(line)
  }

  // The store is built eagerly, and the reason is worth stating plainly: `appendEntry` is
  // on the ExtensionAPI and available the moment the factory is called, and `getBranch` is
  // never consulted while *constructing* the store — `restoreFromBranch` takes the branch
  // as an argument, not as a hook. So no session manager is needed to make Σ durable.
  // Building it lazily instead would hand the tool and the transform `storage ===
  // undefined`, which is a memory-only Σ that looks exactly like a working one.
  const storage = createPiStorage({
    appendEntry: (customType: string, data: unknown): unknown => {
      if (typeof pi.appendEntry === "function") return pi.appendEntry(customType, data)
      warn("this host has no appendEntry, so Σ is not durable")
      return undefined
    },
    log,
  })

  const deps: TransformDeps = {
    config,
    storage,
    log,
  }

  const tool = createPiSkillState({ storage })
  const command = createPiSkillStateCommand({
    deps,
    payloadOf: (sessionID) => payloads.get(sessionID),
    replyOf: (ctx: ExtensionCommandContext) => (text: string) => {
      // Guarded twice over: a surface with no UI is not a surface that reads a note, and a
      // host that throws on a notify is not one whose turn should break either.
      if (ctx?.mode !== "tui") return
      if (ctx?.hasUI !== true) return
      try {
        ctx.ui.notify(text, "info")
      } catch (error) {
        warn("the reply could not be shown: " + messageOf(error))
      }
    },
  })

  // The session manager is only reachable from an event, so restoration happens on the
  // first `session_start` this process sees — that is the only moment a resumed session
  // can be detected. The store itself was already built at the top of this factory, which
  // is what keeps the tool's writes durable from the very first call.
  let restored = false
  const restoreFrom = (branch: ReadonlyArray<unknown>): void => {
    if (restored) return
    restored = true
    try {
      const found = restoreFromBranch(storage, branch, deps.log)
      if (found !== undefined && config.debug === true) warn("resumed with Σ from the branch")
    } catch (error) {
      // A branch that cannot be walked leaves the session in memory, which is what every
      // host without a storage seam does anyway.
      warn("the branch could not be walked, so Σ is in memory only: " + messageOf(error))
    }
  }

  registerPiContext(pi, {
    deps,
    log: deps.log,
    onRequest: (sessionID, payload) => remember(sessionID, payload),
  })

  // Both registrations return void on this host, unlike OpenCode's which hand back a
  // disposable — so there is nothing to accumulate here, and nothing to dispose. That is
  // measured, not assumed: it is exactly why the ToolBridge and CommandBridge ports in
  // `src/core/ports.ts` had to be corrected by evidence rather than implemented as
  // written.
  pi.registerTool(tool)
  if (config.manualCommand === true) {
    pi.registerCommand("skillstate", command)
  }

  // The first `session_start` this process sees is what makes the store durable-aware: the
  // branch it carries is what a resumed session is rebuilt from.
  pi.on("session_start", (event: any) => {
    try {
      const manager = event?.ctx?.sessionManager ?? event?.sessionManager
      const branch = typeof manager?.getBranch === "function" ? (manager.getBranch() as ReadonlyArray<unknown>) : []
      restoreFrom(Array.isArray(branch) ? branch : [])
    } catch (error) {
      warn("the session could not be restored, so Σ is in memory only: " + messageOf(error))
    }
  })
}

// The two context types this factory hands inward are declared for the signatures above;
// they are imported as types so this module has no runtime dependency on the host.
export type { ExtensionCommandContext, ExtensionToolContext }
