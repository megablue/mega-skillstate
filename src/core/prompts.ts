/**
 * Every word this plugin puts in front of the model.
 *
 * Three channels, and each has one job. The **section** is the standing policy: it is
 * static for the whole session, so a provider cache sees the same bytes on every
 * request. The **state message** is the moment: Σ as it stands, plus what the collapse
 * replaced. The **tool description** is the contract for the one write the model
 * performs itself.
 *
 * The texts say the same thing three times on purpose: the state is the record, and
 * anything not written to it is gone once its turn falls out of the window. That is the
 * difference between this plugin and an ordinary compactor, and it is the part a model
 * forgets first.
 *
 * @module mega-skillstate/prompts
 */

import { render, STATE_FIELDS, type Sigma } from "./schema.ts"

/**
 * Standing policy, appended to the request's system parts.
 *
 * Static, because a provider's cache is keyed on an exact prefix — the same bytes for
 * every request of a session cost nothing after the first.
 *
 * Written as joined paragraphs rather than one template literal so the prose can be
 * edited as prose; the code spans are ordinary backticks and need no escaping.
 */
export const SECTION_TEXT = [
  "This context window is bounded by an explicit execution state (Σ), not by an",
  "append-only transcript. A `mega_state` message early in the conversation carries",
  "that state as compact JSON: the objective, the plan, what is done, the findings, the",
  "files, the decisions, the approaches already ruled out, and what is open. Read it",
  "first — the turns it replaced are not in this request.",
  "",
  "KEEP Σ CURRENT. Call `skill_state` whenever a sub-goal changes, a step lands, a file",
  "is read or written, a decision is made, or an approach is ruled out. The patch is a",
  "dictionary merge over the current state: set a key to add or update it (arrays",
  "replace wholesale, dictionaries merge key by key), and set a key to `null` to delete",
  "it. Keys outside the schema are dropped, so the runtime keeps Σ well formed. Pass",
  "`step` to set the step index.",
  "",
  "THE STATE IS THE WHOLE RECORD. Anything not committed to Σ through `skill_state` is",
  "dropped when its turn falls out of the recent window — a finding you did not write",
  "down is a finding you will rediscover.",
].join("\n")

/** The schema, one line per key, written for the model rather than for a validator. */
export function schemaText(): string {
  return STATE_FIELDS.map((field) => "- `" + field.key + "`: " + field.hint).join("\n")
}

/**
 * The Σ message: the state as it stands, and what the collapse replaced.
 *
 * Deterministic by construction — the same Σ and the same turn span always render the
 * same bytes — because this text is what the transform injects on every request, and a
 * payload that changes between two runs of the same conversation is a payload that
 * cannot be cached or tested.
 *
 * @param state - the current Σ.
 * @param span - the turns the collapse replaced, when it replaced any.
 */
export function stateMessageText(state: Sigma, span: { from: number; to: number } | undefined): string {
  const lines = [
    "<skill-state>",
    "Σ — the explicit execution state. This is the record of what the model committed",
    "through `skill_state`; superseded turns are collapsed into it rather than kept.",
    "Read it before anything else in this request.",
  ]
  if (span !== undefined) {
    lines.push("", "Collapsed: " + turnSpan(span.from, span.to) + " of this conversation are no longer in the request.")
  } else {
    lines.push("", "Nothing has been collapsed yet: the whole conversation is still here.")
  }
  lines.push("", render(state))
  lines.push(
    "",
    "Keep it current: call `skill_state` to set or merge keys, `null` to delete one, and",
    "`step` to advance the counter. Pass `recall` with a key to read that key back in",
    "full — out of the archive if the fold set it aside — or `archive` to list what the",
    "fold set aside. Anything not written here is dropped with the turn that knew it.",
  )
  lines.push("</skill-state>")
  return lines.join("\n")
}

/** How the schema is handed to the model inside the tool description. */
export function toolDescription(): string {
  return [
    "Write the session's execution state (Σ). The runtime keeps Σ in memory and injects",
    "it into the next request, replacing the turns it has already absorbed — so this is",
    "how anything survives past the recent window.",
    "",
    "Pass `state_patch` as a JSON object of the keys you are setting, merged over the",
    "current state: dictionaries merge key by key, arrays replace wholesale, and a `null`",
    "value deletes the key. A JSON string that encodes the object is parsed as a fallback,",
    "but send the object itself. Pass `step` (integer) to set the step index, and `summary`",
    "for a one-line note about what changed. Keys outside the schema are dropped.",
    "",
    "Or read instead of writing: pass `recall` with a key from Σ to print that key in",
    "full — the archived text if the fold set it aside, its live value otherwise — and",
    "pass `recall` as `archive` to list what the fold set aside, largest first. A",
    "recall performs no write, changes no step, and needs no request to have happened.",
    "Never combine `recall` with `state_patch`, `step` or `summary`: a call is one thing",
    "or the other.",
    "",
    "Schema:",
    schemaText(),
  ].join("\n")
}

/** The slash command's one-line description. */
export const COMMAND_DESCRIPTION = "Print the execution state (Σ) and what the context pass is keeping"

/**
 * The stale reminder: short, static, and appended only at a balanced tail.
 *
 * It says nothing about numbers, because numbers date a message and this one survives
 * on the tail of a long conversation; it repeats the standing rule instead, which is
 * the part that decays.
 */
export function nudgeText(stepsSinceUser: number): string {
  return [
    "<skill-state>",
    "You have taken " + stepsSinceUser + " step(s) since the last instruction. The recent",
    "window is the only verbatim history left in this request; anything not committed to Σ",
    "through `skill_state` will be dropped when its turn is collapsed.",
    "If the work has moved on, update Σ now.",
    "</skill-state>",
  ].join("\n")
}

/** One turn span, named the way the command's index prints it. */
export function turnSpan(from: number, to: number): string {
  return from === to ? "turn " + from : "turns " + from + "-" + to
}

/** The ack `skill_state` hands back. Compact, because it is read once and forgotten. */
export function ackText(input: {
  step: number
  changed: ReadonlyArray<string>
  dropped: ReadonlyArray<string>
  /** True when the patch arrived as a JSON string and the runtime decoded it. */
  fromString?: boolean
}): string {
  const changed = input.changed.length === 0 ? "none" : input.changed.join(", ")
  let text = "skill-state updated → step " + input.step + " (changed: " + changed + ")"
  if (input.dropped.length > 0) {
    text += "\ndropped (not in the schema): " + input.dropped.join(", ")
  }
  if (input.fromString === true) {
    text += "\nnote: state_patch arrived as a JSON string; the runtime parsed it. Pass the object itself next time."
  }
  return text
}
