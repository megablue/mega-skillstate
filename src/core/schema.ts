/**
 * Σ: the schema, the renderer, and the `⊕` merge.
 *
 * The paper's runtime *validates* a patch before applying it, and that is the whole
 * defence against its two state failure modes — a model that overwrites a key it did
 * not mean to, and one that deletes what it did not own. So the schema lives here, in
 * the deterministic runtime, and never in the model's head: a patch names keys this
 * module does not know and they are dropped; a patch sets a key to `null` and it is
 * deleted; an array replaces wholesale rather than merging element by element.
 *
 * @module mega-skillstate/schema
 */

/** Σ: a flat dictionary whose keys the schema owns. */
export type Sigma = Record<string, unknown>

/** What one key of Σ is for, and how it is shaped. */
export interface StateField {
  readonly key: string
  /** One line, written for the model: it is what tells the model what belongs here. */
  readonly hint: string
  readonly kind: "string" | "list" | "map" | "integer"
}

/**
 * The default schema, coding-agent cut.
 *
 * Mirrors the paper's InterCode state (`discovered_flags / tested_hypotheses /
 * active_files / working_dir / cmd_summary`), re-cut for a coding agent. Configurable
 * per install only by replacing this module — the keys are the contract the tool
 * enforces, so they are code, not options.
 *
 * Two container rules decide which shape a key takes, and both serve one thing: a
 * write must never silently lose what an earlier write put in Σ.
 *
 * 1. **A key whose entry is a thing and its reason is a map** (`name -> …`): `⊕` merges
 *    dictionaries key by key, so a finding or a decision written today survives a patch
 *    that does not mention it. A list would replace the lot wholesale.
 * 2. **A key that *is* the current state is a list** (`plan`, `done`, `open`): the newest
 *    full list is the truth, and the hints ask for the whole list rather than a delta.
 *
 * `kind` records that rule for whoever edits this module. It is **not** a validator —
 * `merge` never rejects a shape mismatch — so the hints are the contract the model
 * actually reads, and each one names its own shape.
 */
export const STATE_FIELDS: readonly StateField[] = [
  { key: "objective", hint: "the current sub-goal, one line", kind: "string" },
  { key: "plan", hint: "steps, each { step, status: done|active|todo|blocked }", kind: "list" },
  { key: "done", hint: "a list of one-line items: what is completed", kind: "list" },
  // The three accumulated logs: a map, so a later write merges instead of replacing.
  { key: "findings", hint: "name -> key fact or discovered flag; hypotheses verified or ruled out", kind: "map" },
  { key: "files", hint: "path -> what we know or did there", kind: "map" },
  { key: "decisions", hint: "name -> the decision and why, one line each", kind: "map" },
  { key: "errors_tried", hint: "name -> the approach that failed and why, so it is not repeated", kind: "map" },
  { key: "working", hint: "the environment: { cwd, branch, activeFiles }", kind: "map" },
  { key: "open", hint: "a list: blockers, open questions, concrete next actions", kind: "list" },
  { key: "step", hint: "integer, the current step index", kind: "integer" },
]

/** Every key the schema owns, in schema order. */
export const STATE_KEYS: ReadonlySet<string> = new Set(STATE_FIELDS.map((field) => field.key))

/** The keys a patch names that the schema does not own. */
export function unknownKeys(patch: unknown): string[] {
  if (!isPlainObject(patch)) return []
  return Object.keys(patch).filter((key) => !STATE_KEYS.has(key))
}

/** Is this a dictionary, as opposed to an array, a null, or a scalar? */
export function isPlainObject(value: unknown): value is Sigma {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Σ with every key the schema does not own removed. */
export function validateKeys(state: Sigma): Sigma {
  const clean: Sigma = {}
  for (const key of Object.keys(state)) {
    if (!STATE_KEYS.has(key)) continue
    clean[key] = state[key]
  }
  return clean
}

/**
 * `⊕`: apply a dictionary patch over a state.
 *
 * Three rules, in order of how much damage breaking them does:
 *
 * 1. **A key the schema does not own is dropped.** The runtime owns the schema; a
 *    model that invents one has not extended Σ, it has corrupted it.
 * 2. **A `null` value deletes the key.** That is the paper's own delete operator, and
 *    it is the only way a key leaves Σ — an empty string is a value, a `null` is an
 *    instruction.
 * 3. **Arrays replace wholesale; dictionaries merge key by key.** Two patches to
 *    `plan` mean the newest list of steps, not a concatenation of both, and two
 *    patches to `files` mean both files are known.
 *
 * The base is never mutated: the caller compares before and after to say what changed.
 *
 * @param state - the current Σ.
 * @param patch - the model's `state_patch`; anything that is not an object is a no-op.
 * @returns a new Σ.
 */
export function merge(state: Sigma, patch: unknown): Sigma {
  if (!isPlainObject(patch)) return { ...state }
  const next: Sigma = { ...state }
  for (const key of Object.keys(patch)) {
    if (!STATE_KEYS.has(key)) continue
    const value = patch[key]
    if (value === null) {
      delete next[key]
      continue
    }
    next[key] = mergeValue(next[key], value)
  }
  return next
}

/** `⊕` for one value: a dictionary merges, everything else replaces. */
function mergeValue(current: unknown, value: unknown): unknown {
  if (isPlainObject(current) && isPlainObject(value)) return mergePlain(current, value)
  return value
}

/** `⊕` over two dictionaries, where `null` still deletes at any depth. */
function mergePlain(current: Sigma, patch: Sigma): Sigma {
  const next: Sigma = { ...current }
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (value === null) {
      delete next[key]
      continue
    }
    next[key] = mergeValue(next[key], value)
  }
  return next
}

/** A stable fingerprint of one value, for change detection. */
export function fingerprint(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? "undefined" : text
  } catch {
    return String(value)
  }
}

/** The keys whose value differs between two states, in schema order. */
export function changedKeys(before: Sigma, after: Sigma): string[] {
  const changed: string[] = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (fingerprint(before[key]) !== fingerprint(after[key])) changed.push(key)
  }
  const order = new Map(STATE_FIELDS.map((field, index) => [field.key, index]))
  return changed.sort((left, right) => (order.get(left) ?? 999) - (order.get(right) ?? 999))
}

/**
 * Σ as compact JSON, with a stable key order.
 *
 * The order is canonical — schema order first, then anything left alphabetically, and
 * the same rule inside every dictionary — because the rendered text is what gets
 * injected into the request, and the injected message must be the same bytes on every
 * request or a provider prefix cache goes cold and the smoke test's idempotence
 * assertion fails.
 */
export function render(state: Sigma): string {
  return JSON.stringify(topOrdered(state))
}

/** Σ with its keys in the canonical order, and every value ordered beneath it. */
function topOrdered(state: Sigma): unknown {
  if (!isPlainObject(state)) return orderedValue(state)
  const out: Sigma = {}
  for (const field of STATE_FIELDS) {
    if (state[field.key] !== undefined) out[field.key] = orderedValue(state[field.key])
  }
  for (const key of Object.keys(state).sort()) {
    if (out[key] === undefined && state[key] !== undefined) out[key] = orderedValue(state[key])
  }
  return out
}

/** One value with every nested dictionary in canonical key order. */
function orderedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedValue)
  if (isPlainObject(value)) {
    const out: Sigma = {}
    for (const key of Object.keys(value).sort()) out[key] = orderedValue(value[key])
    return out
  }
  return value
}
