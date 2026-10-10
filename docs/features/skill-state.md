# Σ — schema, store, and the ⊕ merge

Status: shipped (v0.2) · Read when: Σ fields; a null that should delete; an unknown key that should be dropped; arrays replace vs merge; seeding from tools; state persistence / restart; render/stability.

User-visible behavior: `docs/SPEC.md` → Scope, Compaction. The state is the sufficient statistic the paper's runtime maintains; see the paper `docs/arXiv-2608.26263v2/acl_latex.tex` source and `DESIGN.md` for the design.

## What it does

- Holds one structured execution state **Σ per session**, durable under
  `state/<sessionID>` in the plugin-scoped KV (`ctx.storage`), with an in-memory LRU
  (`MAX_SESSIONS`) as a **write-through cache** in front of it.
- The **⊕ merge** applied to a `state_patch`: recursive dict merge, a `null` deletes a key at
  any depth, arrays replace wholesale, and **top-level keys the schema does not own are dropped**.
- Seeds `files`/`cwd`/`activeFiles`/`step` from tool calls — **only filling holes**, never
  clobbering model-authored Σ.
- Renders Σ with **canonical key order** so the injected bytes are stable and cacheable.

## Map

- `src/schema.ts` — `STATE_FIELDS` / `StateField` (the contract), `merge`
  (⊕; recursive dict merge + null-delete), `validateKeys`, `unknownKeys`, `changedKeys`,
  `fingerprint`, `render` / `orderedValue` (canonical order).
- `src/state.ts` — `stateStore(sessionID, { storage, log })` (async: a cache **miss**
  does one `storage.get`, a hit is served from memory), `stateKey`, `PersistedState`
  (`{ state, collapsed, summary }`), `MAX_SESSIONS = 64`, `resetStateStore` / `forgetSession`
  / `stateOf` / `stateCount`, per-session record: `apply`, `set`, `seed` (holes only), `step`
  (reads `Σ.step`), `setCollapsed` / `collapsed`, `setSummary`, `observeUser`, `hydrated`,
  turn memory `turnOf` / `assignTurn` / `highestTurn`.
- `src/seed.ts` — `seedHintsFromMessages` (the scan), `seedHints` (the transform's window
  slice), `EMPTY_HINTS`, `SeedHints`; tracks only `trackTools` calls and `glob`-style results.
- `src/view.ts` — `valueText`, injected-id helpers (shared with the collapse pass).

## How & why

- **The schema lives in the runtime, never in the model's head.** The paper's whole defence
  against its two state failure modes — a model *overwriting* a key it did not mean to and one
  *deleting* what it did not own — is a deterministic runtime that validates before applying.
  So: an unknown top-level key is dropped; a `null` deletes; an array replaces (it is never
  element-merged); a plain object merges, so a patch to `files/a` does **not** wipe `files/b`.
- **Base is never mutated** (`merge` starts from `{ ...state }`); a rejected patch leaves Σ
  exactly as it was. The merge itself stays synchronous: load, merge, persist.
- **`step` lives inside Σ** (`Σ.step`), so a step the seed or a prior write set continues
  rather than restarting — the counter is a key, not a private tally.
- **Render is canonical** (schema order for known keys, then alphabetical; nested dict keys
  sorted) so two renders of the same Σ are byte-identical — the property idempotence and
  provider prefix caching both depend on.

### Durability

- **Write-through, and reads are async.** `apply`/`set`/`seed`/`setCollapsed`/`setSummary` each
  `await storage.set` after the in-memory write, so the state a pass is holding is never a
  draft the store never saw. `seed` skips the write when it filled nothing.
- **Degradation is a mode, not a failure.** No store, a refused `get`, a refused `set`, or a
  malformed value all leave the session running in memory; the reason goes to the log under
  `debug`. What it must never do is throw.
- **What survives a restart:** Σ, the committed span and the model's note. What does not: turn
  numbering, which is re-derived from the payload each pass, and `stepsSinceUser`.

### Traps

- **A record captures the storage handle at creation.** One plugin instance per process, so this
  is invisible in practice, but two hosts in one process do not share a store.
- **Arrays replace, and only the current-state keys are arrays.** `plan`/`done`/`open` are
  replaced wholesale by a patch; the model must send the full new list, not a delta. The
  accumulated logs — `findings`/`decisions`/`errors_tried` — are **maps**, so a later write
  merges key by key and an entry made yesterday survives a patch that does not mention it.
  Both shapes are pinned by the smoke test.
- Trap — **`kind` is declarative, not a validator.** `STATE_FIELDS.kind` documents each
  key's shape and `merge` never rejects a mismatch, so a wrong-shaped write passes silently.
  The *hints* are the contract the model actually reads, which is why every hint names its
  own shape (`name -> …` for a map, `a list:` for an array) — when one is ambiguous the
  model drifts, which is exactly how this trap was found.

## Config keys / UI

| Key | Default | Meaning |
| --- | --- | --- |
| `seedFromTools` | `true` | keep `files`/`cwd`/`activeFiles`/`step` current from observed tool calls |
| `trackTools` | `["read","edit","write","patch","glob","shell"]` | tool names scanned when seeding |
| `debug` | `false` | report a refused store read/write to stderr |

## Tests that pin it

`scripts/smoke.mjs` — merge (null deletes, unknown keys dropped, arrays replace, and the
log maps merge: a second `findings`/`decisions` patch adds rather than replaces), stable
render, **durable write** (`state/ses_smoke` persisted with the model's keys and the
committed span), **restart** (`resetStateStore` + the store kept: Σ, the span and every
model-authored key come back), **compaction after restart**, **no storage seam**,
**broken store** (reported, never thrown), seeding fills holes only, idempotence.

## Related

- `context-collapse.md` — where Σ is injected and the prefix collapsed.
- `skill-state-controls.md` — the `skill_state` tool that writes Σ.
- `compaction.md` — the compaction seam that reads Σ and owns the summary.
- `configuration.md` — where the values for the keys above come from.
