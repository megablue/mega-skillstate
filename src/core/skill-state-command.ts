/**
 * `/skillstate`'s semantics: print the state, and what the context pass is keeping.
 *
 * Two jobs, one command. With no argument it is the window into what the transform is
 * actually doing — Σ as it stands, the measured context, the window, how many recent
 * turns are kept, and a per-turn index saying which turns were collapsed into Σ and
 * which are still verbatim. A policy nobody can inspect is a policy nobody can tune, and
 * this is the only place the model's account of a conversation can be compared against
 * what it will actually be sent.
 *
 * `now` forces a pass immediately against the live payload. It bypasses the
 * minimum-turn gate — the whole point of asking by hand — and nothing else: the safe-cut
 * rules, the protected head and the balanced-tail rule still apply, because a hand-asked
 * collapse is not permission to split a tool pair.
 *
 * Everything here is a pure function of the descriptor, because the descriptor is the
 * measurement both the transform and the command read. The argument parsing (`now`
 * versus nothing), the payload lookup and the reply channel are the host's and stay in
 * each adapter: Pi's command takes a **string** where OpenCode's takes an invocation
 * object, and Pi answers through `ctx.ui.notify` where OpenCode prompts the session.
 *
 * @module mega-skillstate/skill-state-command
 */

import { estimateTokens, type ContextDescriptor } from "./context.ts"
import { COMMAND_DESCRIPTION, turnSpan } from "./prompts.ts"
import { render } from "./schema.ts"

/** The command's name, on every host. */
export const COMMAND_NAME = "skillstate"

/** What the command needs from a session record. */
export interface StateView {
  get(): Record<string, unknown>
  step(): number
  summary(): string | undefined
}

/** The state block: Σ as compact JSON, with its step and the model's note. */
export function stateBlock(record: StateView): string {
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
export function turnIndex(descriptor: ContextDescriptor): string {
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

/** The command's one-line description, on every host. */
export function commandDescription(): string {
  return COMMAND_DESCRIPTION
}

/** What a forced pass produced, phrased for the reply the user reads. */
export function forcedReport(input: {
  readonly collapsed: { readonly from: number; readonly to: number; readonly messages: number } | undefined
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly notes: ReadonlyArray<string>
}): string {
  const lines: string[] = []
  if (input.collapsed === undefined) {
    lines.push(
      "Nothing could be collapsed: " +
        (input.notes.length > 0 ? input.notes.join(" | ") : "there is no superseded prefix"),
    )
  } else if (input.collapsed.messages > 0) {
    lines.push(
      "Collapsed " +
        turnSpan(input.collapsed.from, input.collapsed.to) +
        " (" +
        input.collapsed.messages +
        " message(s)) into Σ",
    )
  } else {
    lines.push(
      "Σ already stands for " +
        turnSpan(input.collapsed.from, input.collapsed.to) +
        "; nothing left to collapse this pass",
    )
  }
  lines.push("context " + input.tokensBefore + " -> " + input.tokensAfter + " tokens")
  // This line is only ever written when this pass actually folded something: the
  // request carrying the command has already been sent, so the collapse it
  // forces reaches the *next* one. When the span is already collapsed, or when
  // nothing could be collapsed at all, the next request carries the same payload
  // *plus* Σ rather than a newly collapsed one — and claiming otherwise reads as
  // a result when it is a constant. A live pass once printed this alongside a
  // 41,000-token regression, which is exactly when the model is asking whether
  // Σ is working. See `msf-ld0`.
  if (input.collapsed !== undefined && input.collapsed.messages > 0) {
    lines.push("the next request carries the collapsed payload; the one this call came from is already in flight")
  }
  for (const note of input.notes) lines.push("note: " + note)
  return lines.join("\n")
}

/** The reply when no request has been seen for a session yet, for either job. */
export function nothingYetReport(force: boolean): string {
  return "No request has been seen for this session yet, so there is nothing to " + (force ? "collapse." : "measure.")
}

/** The tail appended to a plain `/skillstate` reply. */
export const NOW_HINT = "\n\n`/" + COMMAND_NAME + " now` forces a collapse on this pass."
