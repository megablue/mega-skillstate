/**
 * `/skillstate`, as Pi's command registry wants it.
 *
 * Two jobs, one command, both host-free decisions: print the state and what the pass is
 * keeping, or `now`, which forces a pass against the live payload.
 *
 * What is Pi's here is the argument, the reply channel, and the payload lookup — and all
 * three differ from OpenCode in ways that are worth naming, because this is the file where
 * the second adapter earns its keep.
 *
 * 1. **The argument is a string**, not an invocation object. So there is no
 *    `prompt.text` to read: the handler's own parameter *is* the argument, and `now` is a
 *    trimmed string comparison. This is the smaller surface of the two.
 * 2. **The reply channel is per-invocation, not per-plugin.** OpenCode hands `setup` a
 *    `session` domain that outlives any single call, so `reply` is captured once and
 *    reused. Pi hands the *handler* a context, so the channel has to be built inside the
 *    handler from that invocation's context. Hence `replyOf(ctx)` rather than a captured
 *    `reply`.
 * 3. **Pi's command has no payload seam.** OpenCode's command can re-read the conversation
 *    the host is about to send, because a tool call is answered from inside a request. Pi
 *    answers through `ctx.ui.notify`, which does not trigger a turn — so there is no
 *    in-flight payload to measure. The last-request map is therefore adapter-held: the
 *    context pass records what it saw, and the command reads that.
 *
 * The guard on the reply is not decoration. `ctx.mode` is how the host says which surface
 * it is on, and a notify on a surface with no UI is a write to a channel nobody reads.
 *
 * @module mega-skillstate/adapters/pi/command
 */

import {
  applyTransform,
  describeContext,
  type ContextDescriptor,
  type TransformDeps,
} from "../../core/context.ts"
import {
  commandDescription,
  forcedReport,
  nothingYetReport,
  NOW_HINT,
  stateReport,
} from "../../core/skill-state-command.ts"
import type { LastRequest } from "../../core/types.ts"
import type { ExtensionCommandContext, PiCommandDefinition } from "./types.ts"

/** Everything the command needs from the plugin's wiring. */
export interface PiSkillStateCommandOptions {
  readonly deps: TransformDeps
  /** The last request the context pass saw — Pi commands have no payload seam of their own. */
  readonly payloadOf: (sessionID: string) => LastRequest | undefined
  /** The reply channel, built per invocation out of that invocation's context. */
  readonly replyOf: (ctx: ExtensionCommandContext) => (text: string) => void
}

/** Build `/skillstate` for Pi's registry. */
export function createPiSkillStateCommand(options: PiSkillStateCommandOptions): PiCommandDefinition {
  const describeFor = async (sessionID: string, payload: LastRequest): Promise<ContextDescriptor> => {
    return await describeContext(options.deps, {
      sessionID,
      model: payload.model,
      system: payload.system,
      messages: payload.messages,
    })
  }

  return {
    description: commandDescription(),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sessionID = typeof ctx?.sessionId === "string" ? ctx.sessionId : undefined
      if (sessionID === undefined) return
      const reply = options.replyOf(ctx)
      // The argument *is* the string, so `now` is a direct comparison against it. OpenCode
      // reaches the same word through `invocation.prompt.text`; the wording is shared, the
      // route to it is not.
      const force = String(args ?? "").trim() === "now"

      const payload = options.payloadOf(sessionID)
      if (payload === undefined) {
        reply(nothingYetReport(force))
        return
      }

      // `now` runs the pass immediately against the last payload this plugin measured. It
      // bypasses the minimum-turn gate — the whole point of asking by hand — and nothing
      // else: the safe-cut rules and the protected head still apply, because a hand-asked
      // collapse is not permission to split a tool pair.
      if (force === true) {
        const report = await applyTransform(options.deps, {
          sessionID,
          model: payload.model,
          system: payload.system,
          messages: payload.messages,
          force: true,
        })
        reply(forcedReport(report))
        return
      }

      reply(stateReport(await describeFor(sessionID, payload), options.deps.config.sigmaWarnTokens) + NOW_HINT)
    },
  }
}
