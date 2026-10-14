/**
 * Σ condensation: fold the prose Σ has stopped needing.
 *
 * The collapse bounds a session by *turn count* and the erosion bounds what the
 * payload's calls carry, but neither touches Σ itself, and Σ only ever grows. A
 * live session measured 232,607 characters of render (~58K tokens) with findings
 * at 79 percent of it, because every finding is written once, in full, and never
 * revisited. Two things follow, and this module is both of them:
 *
 * 1. **Supersession.** A finding whose key is another key plus a correction
 *    suffix (`_corrected`, `_again`, …) replaces the key it corrects, and a
 *    numbered series (`probe_step3`) keeps only its newest member. What groups is
 *    a **suffix or a number**, never a prefix: `edit_indentation_mismatch` and
 *    `edit_in_progress_wrong` are different lessons that happen to share a first
 *    word, and a rule that merged them would be a rule that deletes knowledge.
 *    Three members are the floor for a series — a pair is as likely to be two
 *    observations as one superseding the other.
 * 2. **Length.** A finding longer than the floor keeps its head and its tail. The
 *    geometry is `cappedResultText`'s, and for the same reason: the two ends are
 *    what a reader checks first, and the marker is charged to the budget so a
 *    second pass over the result is a no-op.
 *
 * Nothing is destroyed. Whatever leaves the render is written to the session's
 * **archive**, under the key it came from, inside the same durable record and in
 * the same write — so a restart keeps it. The archive is cold: `render` never
 * emits it, which is the whole point (the bytes stop being charged to every
 * request while the text survives). It reads back through `/skillstate <key>`,
 * which prints one entry in full, and `/skillstate archive`, which lists what was
 * set aside — so a fold shortens a finding rather than deleting it. That read path
 * lives in `skill-state-command.ts`; this module only writes.
 *
 * Idempotent by construction, which is what makes it safe to run on every write:
 * a superseded key is gone, a folded finding is at or under the floor, and a
 * series with one member left is not a series. It is also silent when it did
 * nothing — the caller compares the report, and an untouched Σ is handed back as
 * the same object.
 *
 * @module mega-skillstate/sigma-condense
 */

import { isPlainObject } from "./schema.ts"
import type { Archive } from "./state.ts"

/**
 * How many characters of folded text one session's archive may hold.
 *
 * The archive is durable cold storage, so it is bounded: oldest out first, and a
 * key's newest full text is the one worth keeping.
 *
 * The bound has to be generous *relative to the size gate the fold runs under*, and
 * that is the measurement behind the number. A Σ past `sigmaWarnTokens` is ~64,000
 * characters, so a single fold pass can set aside tens of thousands of them at once:
 * a bound near that size evicts, on every pass, what the previous pass kept. 256 KB
 * holds several such passes, or a few hundred findings at the measured median size
 * (370 characters).
 */
export const MAX_ARCHIVE_CHARS = 262144

/** What the fold did, in the numbers the write path reads. */
export interface CondenseReport {
  /** Findings shortened to their head and tail. */
  readonly folded: number
  /** Findings dropped because a later key supersedes them. */
  readonly superseded: number
  /** Render characters the folds removed, measured on the findings dictionary. */
  readonly bytesFreed: number
}

/** Nothing was touched. */
export const NO_CONDENSE: CondenseReport = { folded: 0, superseded: 0, bytesFreed: 0 }

/** What the caller's config says about folding. */
export interface CondenseOptions {
  /** A finding longer than this keeps its head and tail. 0 disables the fold. */
  readonly maxChars: number
}

/**
 * The suffixes that say a key is a correction of the key before it.
 *
 * A closed list on purpose. The rule has to be readable off the key alone — no
 * prose, no similarity scoring — because a fold that guessed would eventually
 * merge a finding that was still the only record of something.
 */
const SUPERSEDING_SUFFIXES: readonly string[] = [
  "_corrected",
  "_fixed",
  "_resolved",
  "_revised",
  "_updated",
  "_again",
  "_actually",
  "_final",
]

/** The key this one corrects, when its own name says it does. */
export function correctedKey(key: string): string | undefined {
  for (const suffix of SUPERSEDING_SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) return key.slice(0, key.length - suffix.length)
  }
  return undefined
}

/** The stem of a numbered variant: `probe_step3` and `probe_3` are both `probe`. */
export function seriesStem(key: string): string | undefined {
  const match = /^(.*)_step\d+$/.exec(key) ?? /^(.*)_\d+$/.exec(key)
  return match === null ? undefined : match[1]
}

/** The number a series member carries, for choosing which one is newest. */
function seriesNumber(key: string): number {
  const match = /\d+$/.exec(key)
  return match === null ? 0 : Number(match[0])
}

/**
 * The two halves of the fold marker, split so its width can be computed before the
 * marker is built.
 *
 * The width has to be arithmetic and never the length of a built placeholder: a
 * placeholder assembled by concatenating a number contributes the number's
 * *digits*, not its digit *count*, so measuring it under-reserves the budget by
 * `digits - 1` and the value comes out over the floor it was sized for. That is a
 * measured mistake, not a hypothetical one — 400 became 404.
 */
const FOLD_HEAD = "\n[... folded "
const FOLD_TAIL = " chars into the archive ...]\n"

/**
 * A folded finding: the head, a marker naming what left, and the tail.
 *
 * The marker is charged to the budget, so the result is never longer than the
 * floor — which is what makes a second pass over it a no-op. The marker says where
 * the text went rather than that it is gone, because the two are different claims
 * and only one of them is true here.
 */
export function foldedFindingText(value: string, budget: number): string {
  if (value.length <= budget) return value
  // The omitted count is below the value's own length, so it cannot need more
  // digits than the length does. Reserving for the longer one is an upper bound on
  // what the marker will occupy, and an upper bound is what keeps the result at or
  // under the budget.
  const reserved = FOLD_HEAD.length + String(value.length).length + FOLD_TAIL.length
  const room = Math.max(0, budget - reserved)
  if (room <= 1) return value.slice(0, budget)
  const head = Math.floor(room / 2)
  const tail = value.slice(value.length - (room - head))
  const omitted = value.length - head - tail.length
  return value.slice(0, head) + FOLD_HEAD + omitted + FOLD_TAIL + tail
}

/**
 * The archive with its oldest entries dropped until it fits its bound.
 *
 * The **newest entry is never the one dropped**, even when it is larger than the
 * bound on its own. A bound that could evict the text just taken out of the render
 * would turn the fold into exactly the loss the archive exists to prevent — and it
 * did, until this loop was measured: draining a 90,000-character finding against a
 * 65,536-character bound emptied the archive completely, so the write persisted an
 * archive of nothing and destroyed the finding it had just folded. So the bound is
 * a target the older entries yield to, never a cap the newest one is destroyed for.
 */
function boundedArchive(archive: Record<string, string>): Record<string, string> {
  const keys = Object.keys(archive)
  let total = 0
  for (const key of keys) total += archive[key].length
  let first = 0
  while (total > MAX_ARCHIVE_CHARS && first < keys.length - 1) {
    total -= archive[keys[first]].length
    first += 1
  }
  if (first === 0) return archive
  const kept: Record<string, string> = {}
  for (let index = first; index < keys.length; index += 1) kept[keys[index]] = archive[keys[index]]
  return kept
}

/**
 * Fold one session's findings, and the archive that receives what leaves them.
 *
 * @param findings - the current `Σ.findings`, or anything else that was there.
 * @param archive - what earlier folds set aside.
 * @param options - the floor, and the switch that is `maxChars: 0`.
 * @returns the folded findings, the enlarged archive, and what the fold did. When
 *   nothing changed, both are the arguments themselves, so a caller can tell by
 *   identity that there is nothing to write.
 */
export function condense(
  findings: unknown,
  archive: Archive,
  options: CondenseOptions,
): { findings: Record<string, unknown>; archive: Archive; report: CondenseReport } {
  const budget = Math.floor(options.maxChars)
  if (!isPlainObject(findings) || budget <= 0) {
    return { findings: isPlainObject(findings) ? findings : {}, archive, report: NO_CONDENSE }
  }
  const kept: Record<string, unknown> = { ...findings }
  const held: Record<string, string> = { ...archive }
  let folded = 0
  let superseded = 0

  /** Move one key's text into the archive, newest last so the bound evicts the oldest. */
  const setAside = (key: string, text: string): void => {
    // Delete before setting, so a key folded again moves to the newest end rather
    // than keeping the position it had when it was first written.
    delete held[key]
    held[key] = text
  }

  // 1. A correction replaces what it corrects. Both sides have to be strings: a
  //    non-string value is not something this module can hand to the archive, and
  //    dropping one it cannot hold would be the loss the whole design avoids.
  for (const key of Object.keys(kept)) {
    const base = correctedKey(key)
    if (base === undefined || base === key) continue
    const corrected = kept[base]
    if (typeof corrected !== "string" || typeof kept[key] !== "string") continue
    setAside(base, corrected)
    delete kept[base]
    superseded += 1
  }

  // 2. A numbered series keeps its newest member.
  const series = new Map<string, string[]>()
  for (const key of Object.keys(kept)) {
    const stem = seriesStem(key)
    if (stem === undefined) continue
    const members = series.get(stem)
    if (members === undefined) series.set(stem, [key])
    else members.push(key)
  }
  for (const members of series.values()) {
    if (members.length < 3) continue
    let newest = members[0]
    for (const key of members) {
      if (seriesNumber(key) > seriesNumber(newest)) newest = key
    }
    for (const key of members) {
      if (key === newest) continue
      const text = kept[key]
      if (typeof text !== "string") continue
      setAside(key, text)
      delete kept[key]
      superseded += 1
    }
  }

  // 3. Length, on what is left. Only strings, and only over the floor.
  for (const key of Object.keys(kept)) {
    const value = kept[key]
    if (typeof value !== "string" || value.length <= budget) continue
    setAside(key, value)
    kept[key] = foldedFindingText(value, budget)
    folded += 1
  }

  if (folded === 0 && superseded === 0) return { findings, archive, report: NO_CONDENSE }

  const before = JSON.stringify(findings).length
  const after = JSON.stringify(kept).length
  return {
    findings: kept,
    archive: boundedArchive(held),
    report: { folded, superseded, bytesFreed: Math.max(0, before - after) },
  }
}
