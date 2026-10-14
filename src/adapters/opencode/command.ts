/**
 * `/skillstate`: the envelope, as OpenCode's command registry wants it.
 *
 * The report the command prints — the state, the numbers, the per-turn index — and the
 * phrasing of a forced pass are host-free decisions and live in
 * `src/core/skill-state-command.ts`. What is left here is the three OpenCode-shaped
 * questions: which session the command was invoked in, what argument it was given, and
 * which channel answers the user on.
 *
 * The last one is the part that differs most between hosts. OpenCode answers by prompting
 * the session, which is why a reply costs a turn here; Pi answers through `ctx.ui.notify`,
 * which does not trigger one. That difference is a reason to keep the reply channel behind
 * a parameter rather than to fork the command's logic.
 *
 * @module mega-skillstate/adapters/opencode/command
 */

import {
  applyTransform,
  describeContext,
  type ContextDescriptor,
  type TransformDeps,
} from "../../core/context.ts"
import { COMMAND_DESCRIPTION } from "../../core/prompts.ts"
import { sessionIdOf } from "../../core/skill-state.ts"
import {
  COMMAND_NAME,
  forcedReport,
  nothingYetReport,
  NOW_HINT,
  type StateView,
  stateReport,
} from "../../core/skill-state-command.ts"
import type { CommandDefinition, CommandInvocation, LastRequest } from "./types.ts"

// Re-exported so the names this adapter has always answered for still resolve from the
// page the feature map points at, now that the definitions live in the core.
export { COMMAND_NAME, stateBlock, stateReport, turnIndex } from "../../core/skill-state-command.ts"

/** Everything the command needs from the plugin's wiring. */
export interface SkillStateCommandOptions {
  readonly deps: TransformDeps
  /** The last request this plugin saw, which is the conversation the command acts on. */
  readonly payloadOf: (sessionID: string) => LastRequest | undefined
  readonly reply: (sessionID: string, text: string) => Promise<void>
}

/**
 * Build `/skillstate`.
 *
 * @returns the command definition, ready for `command.transform`.
 */
export function createSkillStateCommand(options: SkillStateCommandOptions): CommandDefinition {
  const describeFor = async (sessionID: string, payload: LastRequest): Promise<ContextDescriptor> => {
    return await describeContext(options.deps, {
      sessionID,
      model: payload.model,
      system: payload.system,
      messages: payload.messages,
    })
  }

  return {
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    execute: async (invocation: CommandInvocation) => {
      const sessionID = sessionIdOf(invocation)
      if (sessionID === undefined) return
      const asked = String((invocation as { prompt?: { text?: unknown } })?.prompt?.text ?? "").trim()
      const say = async (body: string): Promise<void> => {
        await options.reply(sessionID, body)
      }
      const force = asked === "now"

      // Both jobs answer the same way when no request has been seen yet: there is nothing
      // to measure and nothing to collapse, and the reply says which of the two it meant.
      const payload = options.payloadOf(sessionID)
      if (payload === undefined) {
        await say(nothingYetReport(force))
        return
      }

      // `now` runs the pass immediately against the live payload. It bypasses the
      // minimum-turn gate — the whole point of asking by hand — and nothing else: the
      // safe-cut rules, the protected head and the balanced-tail rule still apply,
      // because a hand-asked collapse is not permission to split a tool pair.
      if (force === true) {
        const report = await applyTransform(options.deps, {
          sessionID,
          model: payload.model,
          system: payload.system,
          messages: payload.messages,
          force: true,
        })
        await say(forcedReport(report))
        return
      }

      await say(
        stateReport(await describeFor(sessionID, payload), options.deps.config.sigmaWarnTokens) + NOW_HINT,
      )
    },
  }
}
