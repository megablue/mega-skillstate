/**
 * `/skillstate`'s semantics: print the state, force a pass, and read back what the fold
 * set aside.
 *
 * Four jobs, one command. With no argument it is the window into what the transform is
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
 * Any other argument is a finding's key, answered out of the session's **archive** — the
 * full text the fold took out of the render. That is what makes the fold a memory rather
 * than a deletion: a folded finding shows its own head and tail in Σ, and its middle is
 * one command away. `archive` lists what was set aside, largest first. Neither job needs
 * the live payload, so both answer in a session no request has reached yet — the archive
 * is durable, and the payload is not.
 *
 * The wording of every answer is decided here, once. What stays in each adapter is where
 * the argument's text comes from, the payload lookup and the reply channel: Pi's command
 * takes a **string** where OpenCode's takes an invocation object, and Pi answers through
 * `ctx.ui.notify` where OpenCode prompts the session.
 *
 * @module mega-skillstate/skill-state-command
 */

import { estimateTokens, type ContextDescriptor, type TransformDeps } from "./context.ts"
import { COMMAND_DESCRIPTION, turnSpan } from "./prompts.ts"
import { render } from "./schema.ts"
import type { Archive, StateRecord } from "./state.ts"
import { stateStore } from "./state.ts"

/** The command's name, on every host. */
export const COMMAND_NAME = "skillstate"

/** What the command needs from a session record. */
export interface StateView {
  get(): Record<string, unknown>
  step(): number
  summary(): string | undefined
  /** The full text of findings the fold replaced; empty when nothing has folded. */
  archive(): Archive
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

/** How much of Σ's render one key is worth, as a share of the whole. */
function keyShare(state: Record<string, unknown>, key: string): number {
  const text = render(state)
  if (text.length === 0) return 0
  const value = state[key]
  if (value === undefined) return 0
  const size = (() => {
    try {
      const json = JSON.stringify(value)
      return typeof json === "string" ? json.length : 0
    } catch {
      return 0
    }
  })()
  return Math.round((size / text.length) * 100)
}

/**
 * The Σ size line, printed only when Σ itself has grown past the warning.
 *
 * Σ is injected into *every* request, so its own growth is the one erosion the
 * collapse cannot see: the pass is indifferent to how many tokens the state
 * message costs. On the measured live case Σ was ~41,000 tokens of a 458,000
 * token payload — roughly a tenth of the window it was bounding. The line
 * names the dominant key, because "consolidate" without saying what dominates
 * is advice the model cannot act on. `0` disables it.
 */
function sigmaSizeLine(record: StateView, threshold: number): string | undefined {
  if (threshold <= 0) return undefined
  const text = render(record.get())
  const tokens = estimateTokens(text)
  if (tokens <= threshold) return undefined
  const findings = keyShare(record.get(), "findings")
  let line =
    "Σ is ~" +
    tokens +
    " tokens, " +
    findings +
    "% of it findings — over the " +
    threshold +
    "-token line; consolidate rather than let it crowd the window"
  // The line that names the pressure also names the way back to what the fold took: a
  // model told to consolidate needs to know the middle of a folded finding is readable,
  // or the archive is a deletion it cannot see.
  const folded = Object.keys(record.archive()).length
  if (folded > 0) {
    line +=
      ". The archive holds " +
      entryCount(folded) +
      " the fold set aside: `/" +
      COMMAND_NAME +
      " <key>` prints one in full"
  }
  return line
}

/** The account the command prints: the state, the numbers, then the per-turn index. */
export function stateReport(descriptor: ContextDescriptor, sigmaWarnTokens = 0): string {
  const lines = [
    stateBlock(descriptor.record),
    sigmaSizeLine(descriptor.record, sigmaWarnTokens),
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
  ]
  // A filtered slot would shift every line below it, so the line is either
  // present or replaced by the blank it already occupies.
  return lines.map((line) => line ?? "").join("\n")
}

/** "1 entry" / "N entries", because the size line and the listing both say it. */
function entryCount(count: number): string {
  return count === 1 ? "1 entry" : count + " entries"
}

/** Σ's findings dictionary, or an empty one when there is nothing readable there. */
function findingsOf(view: StateView): Record<string, unknown> {
  const findings = view.get()["findings"]
  if (typeof findings !== "object" || findings === null || Array.isArray(findings)) return {}
  return findings as Record<string, unknown>
}

/** One value as text: a finding is a string, and anything else is shown as its JSON. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value
  try {
    const json = JSON.stringify(value)
    return typeof json === "string" ? json : String(value)
  } catch {
    return String(value)
  }
}

/** Whether a name is worth offering as a guess: either one contains the other. */
function similarKey(name: string, asked: string): boolean {
  const lower = name.toLowerCase()
  const wanted = asked.toLowerCase()
  return lower.includes(wanted) || wanted.includes(lower)
}

/** What one invocation of the command was asked for. */
export type CommandAsk =
  | { readonly kind: "report" }
  | { readonly kind: "now" }
  | { readonly kind: "archive" }
  | { readonly kind: "recall"; readonly key: string }

/**
 * The argument, read once for every host.
 *
 * OpenCode hands it over as `invocation.prompt.text` and Pi as the handler's own string
 * parameter; the words mean the same thing on both, so the split between "this is a key"
 * and "this is an instruction" happens here rather than in each adapter. A key that
 * arrived quoted or in backticks is unquoted first, because a caller told to name a key
 * will sometimes dress it up.
 */
export function parseAsk(asked: string): CommandAsk {
  const text = String(asked ?? "")
    .trim()
    .replace(/^[`'"]+/, "")
    .replace(/[`'"]+$/, "")
  if (text.length === 0) return { kind: "report" }
  if (text === "now") return { kind: "now" }
  if (text === "archive") return { kind: "archive" }
  return { kind: "recall", key: text }
}

/**
 * The session's record, for the asks that read Σ and the archive without a payload.
 *
 * A recall has nothing to do with the live request: the archive is durable and the
 * payload may not exist yet. This is the one place the command reaches the store rather
 * than the measurement, and it is why a recall answers in a session no request has
 * reached — the same session where the report has to say it has seen nothing.
 */
export async function recordFor(deps: TransformDeps, sessionID: string): Promise<StateRecord> {
  return await stateStore(sessionID, { storage: deps.storage, log: deps.log })
}

/**
 * One finding, in full, from wherever it now lives.
 *
 * Three answers, and the wording says which one this is: the archived text of a folded
 * finding, whose render keeps only its head and tail; the archived text of a superseded
 * one, which Σ no longer holds at all; or a live value that was never folded. A miss
 * names the near matches rather than nothing, because a key asked for by hand is as often
 * a half-remembered name as an exact one.
 */
export function recallReport(key: string, view: StateView): string {
  const held = view.archive()[key]
  const findings = findingsOf(view)
  const live = findings[key]

  if (typeof held === "string") {
    const folded = typeof live === "string"
    return (
      "`" +
      key +
      "` — " +
      held.length +
      " chars, " +
      (folded
        ? "folded: the render keeps its head and tail"
        : "superseded: no longer in Σ, kept only in the archive") +
      "\n\n" +
      held
    )
  }
  if (live !== undefined) {
    const text = textOf(live)
    return "`" + key + "` — live in Σ, " + text.length + " chars (never folded)\n\n" + text
  }

  const near = Object.keys(findings).filter((name) => similarKey(name, key))
  const held_ = Object.keys(view.archive())
  const lines = ["`" + key + "` is not in Σ's findings or the archive."]
  if (near.length > 0) lines.push("closest: " + near.slice(0, 8).join(", "))
  lines.push(
    held_.length === 0
      ? "Nothing has been folded out of Σ yet."
      : "`/" + COMMAND_NAME + " archive` lists the " + entryCount(held_.length) + " the fold set aside.",
  )
  return lines.join("\n")
}

/**
 * What the archive holds: every key the fold set aside, largest first.
 *
 * Largest first because the size is what makes a key worth recalling by hand, and the
 * list is capped because an archive of a few hundred entries is a wall of names. A key no
 * longer in Σ is marked as superseded: for that one the archive is the only copy left.
 */
export function archiveReport(view: StateView, limit = 40): string {
  const archive = view.archive()
  const names = Object.keys(archive)
  if (names.length === 0) {
    return "The archive is empty: nothing has been folded out of Σ yet."
  }
  const findings = findingsOf(view)
  const chars = names.reduce((total, name) => total + archive[name].length, 0)
  const biggest = [...names].sort((left, right) => archive[right].length - archive[left].length)
  const lines = ["archive: " + entryCount(names.length) + ", " + chars + " chars"]
  for (const name of biggest.slice(0, limit)) {
    lines.push("  " + name + " — " + archive[name].length + (name in findings ? "" : " (superseded)"))
  }
  if (biggest.length > limit) lines.push("… and " + (biggest.length - limit) + " more")
  lines.push("`/" + COMMAND_NAME + " <key>` prints one in full.")
  return lines.join("\n")
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
