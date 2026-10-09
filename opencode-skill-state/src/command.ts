/**
 * `/skillstate`: print the state, and force a collapse on demand.
 *
 * Two jobs, one command. With no argument it is the window into what the transform is
 * actually doing — Σ as it stands, the measured context, the window, how many recent
 * turns are kept, and a per-turn index saying which turns were collapsed into Σ and
 * which are still verbatim. A policy nobody can inspect is a policy nobody can tune, and
 * this is the only place the model's account of a conversation can be compared against
 * what it will actually be sent.
 *
 * `now` runs the pass immediately against the live payload. It bypasses the
 * minimum-turn gate — the whole point of asking by hand — and nothing else: the safe-cut
 * rules, the protected head and the balanced-tail rule still apply, because a hand-asked
 * collapse is not permission to split a tool pair.
 *
 * @module opencode-skill-state/command
 */

import {
  applyTransform,
  describeContext,
  estimateTokens,
  type ContextDescriptor,
  type TransformDeps,
} from "./context.ts"
import { COMMAND_DESCRIPTION, turnSpan } from "./prompts.ts"
import { render } from "./schema.ts"
import { sessionIdOf } from "./tool.ts"
import type { CommandDefinition, LastRequest } from "./types.ts"

/** Everything the command needs from the plugin's wiring. */
export interface SkillStateCommandOptions {
  readonly deps: TransformDeps
  /** The last request this plugin saw, which is the conversation the command acts on. */
  readonly payloadOf: (sessionID: string) => LastRequest | undefined
  readonly reply: (sessionID: string, text: string) => Promise<void>
}

/** The command's name. */
export const COMMAND_NAME = "skillstate"

/** What the command needs from a session record. */
interface StateView {
  get(): Record<string, unknown>
  step(): number
  summary(): string | undefined
}

/** The state block: Σ as compact JSON, with its step and the model's note. */
function stateBlock(record: StateView): string {
  const state = record.get()
  const text = render(state)
  const head = "Σ (step " + record.step() + ", ~" + estimateTokens(text) + " tokens)"
  const note = record.summary()
  const body = Object.keys(state).length === 0 ? "{} — nothing committed yet" : text
  return note === undefined ? head + "\n" + body : head + "\n" + body + "\nlast note: " + note
}

/**
 * The per-turn index: what was collapsed into Σ and what is still verbatim.
 *
 * The collapsed span is printed as one line rather than one per turn: sixteen turns
 * folded into a single Σ message is the whole point, and a list of them would be the
 * verbosity the collapse exists to remove.
 */
function turnIndex(descriptor: ContextDescriptor): string {
  const lines: string[] = []
  const head = descriptor.turns[0]
  if (head !== undefined) {
    lines.push("turn " + head.turn + " · kept · the first instruction (protected)")
  }
  if (descriptor.collapsed !== undefined) {
    lines.push(turnSpan(descriptor.collapsed.from, descriptor.collapsed.to) + " · collapsed into Σ")
  }
  for (const turn of descriptor.turns) {
    if (turn === head) continue
    lines.push(
      "turn " +
        turn.turn +
        " · kept · recent window · " +
        turn.nodes +
        " message(s), " +
        turn.calls +
        " tool call(s)" +
        (turn.tools.size > 0 ? ": " + [...turn.tools].join(", ") : ""),
    )
  }
  if (lines.length === 0) lines.push("no turns yet")
  return lines.join("\n")
}

/** The account the command prints: the state, the numbers, then the per-turn index. */
export function stateReport(descriptor: ContextDescriptor): string {
  return [
    stateBlock(descriptor.record),
    "",
    "context " +
      descriptor.tokens +
      " tokens · window " +
      (descriptor.window ?? "unknown") +
      " · keeping the newest " +
      descriptor.keepRecentTurns +
      " turn(s) · " +
      descriptor.turns.length +
      " turn(s) in the payload, currently at turn " +
      descriptor.currentTurn,
    "",
    turnIndex(descriptor),
  ].join("\n")
}

/**
 * Build `/skillstate`.
 *
 * @returns the command definition, ready for `command.transform`.
 */
export function createSkillStateCommand(options: SkillStateCommandOptions): CommandDefinition {
  const describeFor = async (sessionID: string): Promise<ContextDescriptor | undefined> => {
    const payload = options.payloadOf(sessionID)
    if (payload === undefined) return undefined
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
    execute: async (invocation) => {
      const sessionID = sessionIdOf(invocation)
      if (sessionID === undefined) return
      const asked = String((invocation as { prompt?: { text?: unknown } })?.prompt?.text ?? "").trim()
      const say = async (body: string): Promise<void> => {
        await options.reply(sessionID, body)
      }

      if (asked === "now") {
        const payload = options.payloadOf(sessionID)
        if (payload === undefined) {
          await say("No request has been seen for this session yet, so there is nothing to collapse.")
          return
        }
        const report = await applyTransform(options.deps, {
          sessionID,
          model: payload.model,
          system: payload.system,
          messages: payload.messages,
          force: true,
        })
        const lines = [
          report.collapsed === undefined
            ? "Nothing could be collapsed: " +
              (report.notes.length > 0 ? report.notes.join(" | ") : "there is no superseded prefix")
            : report.collapsed.messages > 0
              ? "Collapsed " +
                turnSpan(report.collapsed.from, report.collapsed.to) +
                " (" +
                report.collapsed.messages +
                " message(s)) into Σ"
              : "Σ already stands for " +
                turnSpan(report.collapsed.from, report.collapsed.to) +
                "; nothing left to collapse this pass",
          "context " + report.tokensBefore + " -> " + report.tokensAfter + " tokens",
          "the next request carries the collapsed payload; the one this call came from is already in flight",
        ]
        for (const note of report.notes) lines.push("note: " + note)
        await say(lines.join("\n"))
        return
      }

      const descriptor = await describeFor(sessionID)
      if (descriptor === undefined) {
        await say("No request has been seen for this session yet, so there is nothing to measure.")
        return
      }
      await say(stateReport(descriptor) + "\n\n`/" + COMMAND_NAME + " now` forces a collapse on this pass.")
    },
  }
}
