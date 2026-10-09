# Σ — schema, store, and the ⊕ merge

Status: shipped (v0.1) · Read when: Σ fields; a null that should delete; an unknown key that should be dropped; arrays replace vs merge; seeding from tools; state persistence / restart; render/stability.

User-visible behavior: `docs/SPEC.md` → Scope. The state is the sufficient statistic the paper's runtime maintains; see the paper `arxiv` source and `../../opencode-g-skill-state/SPEC.md` for the design.

## What it does

- Holds one structured execution state **Σ per session** (in memory, LRU, `MAX_SESSIONS`).
- The **⊕ merge** applied to a `state_patch`: recursive dict merge, a `null` deletes a key at
  any depth, arrays replace wholesale, and **top-level keys the schema does not own are dropped**.
- Seeds `files`/`cwd`/`activeFiles`/`step` from tool calls — **only filling holes**, never
  clobbering model-authored Σ.
- Renders Σ with **canonical key order** so the injected bytes are stable and cacheable.

## Map

- `src/schema.ts` — `STATE_FIELDS` / `StateField` (the contract), `merge`
  (⊕; recursive dict merge + null-delete), `validateKeys`, `unknownKeys`, `changedKeys`,
  `fingerprint`, `render` / `orderedValue` (canonical order), `hasSeededStep`.
- `src/state.ts` — `stateStore`, `MAX_SESSIONS = 64`, per-session record:
  `apply` (merge a patch, bump `Σ.step`), `seed` (holes only), `observeUser`
  (`stepsSinceUser`), `setCollapsed` / `collapsed` (remembered span), turn memory
  `turnOf` / `assignTurn` / `highestTurn`.
- `src/seed.ts` — `seedHints`, `EMPTY_HINTS`, `SeedHints`; tracks only `trackTools` calls
  and `glob`-style results, guarded by `min`.
- `src/view.ts` — `valueText`, injected-id helpers (shared with the collapse pass).

## How & why

- **The schema lives in the runtime, never in the model's head.** The paper's whole defence
  against its two state failure modes — a model *overwriting* a key it did not mean to and one
  *deleting* what it did not own — is a deterministic runtime that validates before applying.
  So: an unknown top-level key is dropped; a `null` deletes; an array replaces (it is never
  element-merged); a plain object merges, so a patch to `files/a` does **not** wipe `files/b`.
- **Base is never mutated** (`merge` starts from `{ ...state }); a rejected patch leaves Σ
  exactly as it was.
- **`step` lives inside Σ** (`Σ.step`), incremented by `apply`, and the seed never overwrites a
  step the model or a prior seed set — so a seeded step continues rather than restarting.
- **Render is canonical** (schema order for known keys, then alphabetical; nested dict keys
  sorted) so two renders of the same Σ are byte-identical — the property idempotence and
  provider prefix caching both depend on.
- **Trap — persistence.** The store is in-memory. A plugin/host restart re-expands the context
  to the raw transcript, not to Σ. Durable Σ via `ctx.storage` is the planned follow-up
  (`HANDOFF.md`, `HOST-API-NOTES.md`).
- **Trap — arrays replace.** `plan`/`done`/`findings` are replaced wholesale by a patch; the
  model must send the full new list, not a delta. This is intentional and pinned by the smoke
  test's merge check.

## Config keys / UI

| Key | Default | Meaning |
| --- | --- | --- |
| `seedFromTools` | `true` | keep `files`/`cwd`/`activeFiles`/`step` current from observed tool calls |
| `trackTools` | `["read","edit","write","patch","glob","shell"]` | tool names scanned when seeding |

## Tests that pin it

`scripts/smoke.mjs` — merge (null deletes, unknown keys dropped, arrays replace, objects merge),
stable render, seeding fills holes only, idempotence.

## Related

- `context-collapse.md` — where Σ is injected and the prefix collapsed.
- `skill-state-controls.md` — the `skill_state` tool that writes Σ.
