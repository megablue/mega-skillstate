/**
 * The compaction seam: where the plugin answers "what happened" with Σ instead of asking
 * a model to summarise the transcript.
 *
 * This is the SKILL.state centerpiece in a coding agent. The paper's agent reasons, emits
 * `(R_t, ΔΣ_t, a_t)`, and has `R_t` **discarded**: the trace is not the record, the state
 * is. The live equivalent is that the model maintains Σ *semantically* through
 * `skill_state` as it works, and when the host needs a compaction message, this plugin
 * hands back `render(Σ)` and **no model call happens at all** — the host persists the
 * string as the compaction message and moves on.
 *
 * Two inputs are combined, in this order:
 *
 * 1. the **already-persisted Σ** — everything the model committed, which survives a
 *    restart because it lives in `ctx.storage`;
 * 2. a **deterministic seed sweep of the whole transcript** — files touched, the working
 *    directory, the step count. It fills holes only; a model-authored key is never
 *    clobbered, because the model is the only thing here that knows *why*.
 *
 * If the distilled Σ has nothing worth saying, `result` is left unset so the host falls
 * back to its own summarizer. A compaction message that says nothing is worse than the
 * one the host would have written.
 *
 * `event.messages` is read and never written. This plugin owns the content of the
 * summary, not the transcript it came from.
 *
 * @module mega-skillstate/compaction
 */

import type { ResolvedConfig } from "./config.ts"
import { messageOf } from "./types.ts"
import { stateMessageText } from "./prompts.ts"
import { seedHintsFromMessages, type SeedHints } from "./seed.ts"
import { isPlainObject, type Sigma } from "./schema.ts"
import { stateStore } from "./state.ts"
import type { CollapsedSpan, CompactionEvent, StorageDomain } from "./types.ts"

/** What the compaction pass is allowed to reach outside itself. */
export interface CompactionDeps {
  readonly config: ResolvedConfig
  /** The host's plugin-scoped KV, when the host has one. */
  readonly storage?: StorageDomain
  readonly log?: (line: string) => void
}

/** What one compaction pass decided, printable as it stands. */
export interface CompactionReport {
  readonly sessionID: string | undefined
  /** Whether the distilled Σ was worth handing back. */
  readonly owned: boolean
  /** Whether the seed actually filled anything. */
  readonly seeded: boolean
  /** How many keys the distilled Σ carries. */
  readonly keys: number
  readonly collapsed: CollapsedSpan | undefined
  readonly notes: ReadonlyArray<string>
}

/**
 * The keys that make a distilled Σ worth handing back instead of the host's own summary.
 *
 * `working` and `step` are deliberately absent: a bare working directory is not an
 * account of a session, and the host's fallback summarizer knows more about one than a
 * key-value store does.
 */
const MEANINGFUL: readonly string[] = ["objective", "plan", "done", "findings", "files", "decisions", "open"]

/** Does the distilled Σ say anything? */
export function hasMeaningfulState(state: Sigma): boolean {
  for (const key of MEANINGFUL) {
    const value = state[key]
    if (typeof value === "string" && value.trim().length > 0) return true
    if (Array.isArray(value) && value.length > 0) return true
    if (isPlainObject(value) && Object.keys(value).length > 0) return true
  }
  return false
}

/** The seed, as a Σ patch. Only keys with something to say are set. */
function seedPatch(hints: SeedHints): Sigma {
  const patch: Sigma = {}
  if (Object.keys(hints.files).length > 0) patch["files"] = hints.files
  if (Object.keys(hints.working).length > 0) patch["working"] = hints.working
  if (hints.step > 0) patch["step"] = hints.step
  return patch
}

/**
 * Distill one session's Σ: the persisted state, with the seed's holes filled.
 *
 * @returns the distilled Σ, whether the seed contributed, and the span it has collapsed.
 */
export async function distill(
  deps: CompactionDeps,
  input: { sessionID: string; messages: ReadonlyArray<{ content?: readonly unknown[] }> },
): Promise<{ state: Sigma; seeded: boolean; collapsed: CollapsedSpan | undefined; notes: string[] }> {
  const notes: string[] = []
  const record = await stateStore(input.sessionID, { storage: deps.storage, log: deps.log })
  let seeded = false
  if (deps.config.seedFromTools === true) {
    try {
      const hints = seedHintsFromMessages(input.messages as never, deps.config.trackTools)
      seeded = await record.seed(seedPatch(hints))
      if (seeded === false) notes.push("the seed found nothing the model had not already written")
    } catch (error) {
      notes.push("the seed sweep was refused: " + messageOf(error))
    }
  }
  return { state: record.get(), seeded, collapsed: record.collapsed(), notes }
}

/**
 * Run one compaction pass.
 *
 * Never throws: a compaction the host cannot summarise is a compaction the host
 * summarises itself, and the only thing lost by refusing is the plugin's better summary.
 */
export async function runCompaction(deps: CompactionDeps, event: CompactionEvent): Promise<CompactionReport> {
  const { config } = deps
  const notes: string[] = []
  const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
  const refuse = (why: string): CompactionReport => {
    notes.push(why)
    return { sessionID, owned: false, seeded: false, keys: 0, collapsed: undefined, notes }
  }
  try {
    if (config.enabled !== true) return refuse("the plugin is off, so the host summarises")
    if (config.collapseOlder !== true) return refuse("collapseOlder is off, so there is no Σ to hand back")
    if (sessionID === undefined) return refuse("a compaction event with no session id was left alone")
    const distilled = await distill(deps, { sessionID, messages: event.messages ?? [] })
    notes.push(...distilled.notes)
    if (!hasMeaningfulState(distilled.state)) {
      const line = "the distilled Σ is empty, so the host's own summarizer runs"
      deps.log?.(line)
      return { sessionID, owned: false, seeded: distilled.seeded, keys: 0, collapsed: distilled.collapsed, notes: [...notes, line] }
    }
    // Never written to: only `result` is set, and the host makes no model call when it is.
    event.result = { summary: stateMessageText(distilled.state, distilled.collapsed) }
    const line =
      "compaction owned: distilled Σ (" +
      Object.keys(distilled.state).length +
      " key(s)" +
      (distilled.seeded ? ", seed contributed" : "") +
      ") and skipped the summary request"
    deps.log?.(line)
    return {
      sessionID,
      owned: true,
      seeded: distilled.seeded,
      keys: Object.keys(distilled.state).length,
      collapsed: distilled.collapsed,
      notes: [...notes, line],
    }
  } catch (error) {
    // A refused compaction degrades to the host's own summarizer, which is what would
    // have happened without this plugin at all.
    return refuse("the compaction pass was refused: " + messageOf(error))
  }
}
