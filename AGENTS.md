# AGENTS.md

**Before you grep, glob or open a source file: read `HANDOFF.md`, then
`docs/features/README.md`, then only the feature page(s) for the area you are
about to change. The feature pages name the files, functions and tests you
would otherwise hunt for — the code comes after them, not before.**

opencode-g-skill-state is a plugin for the OpenCode 2.0 CLI (TypeScript, ESM) that
bounds the context window by replacing an append-only conversation history with an
explicit, structured skill-execution state (Σ) — the SKILL.state approach, derived
from the paper in `docs/arXiv-2608.26263v2/`.

Three kinds of document, and keeping them apart is the point:

- **`docs/SPEC.md` is product behavior** — what the product does and what a
  user sees, readable without knowing the code. Behavior belongs there even
  when the code is where the reason for it lives.
- **`docs/features/` is the feature map** — one page per feature with its
  files, mechanisms, traps and pinning tests. Read the page for the area you
  are about to change; keep it true in the same commit.
- **This file is process and hard rules** — the commands, the workflow and
  the constraints that apply across every feature.

Where a rule has a behavior half and a mechanism half, the behavior half is a
pointer to `docs/SPEC.md` and the mechanism half to its feature page rather
than a second copy: two copies of a default value is one more thing that can
be wrong.

## Read first
`HANDOFF.md` holds the current state; if it is missing, carry on with the
feature map and the code. Then `docs/features/README.md` — the feature map —
and only the feature doc(s) for what you are about to change.
`docs/SPEC.md` is user-visible behavior; this file is process and hard rules;
the feature docs are the map, the mechanism and the traps.

## Layout

- **The plugin package is this repo root** — `src/`, `scripts/`, `server.ts`,
  `options.json`, `package.json`, `tsconfig.json` and the three package documents sit
  at the top level; the package was flattened here on `2026-10-10` and the nested
  `opencode-skill-state/` subdirectory it used to live in is gone. Its three documents
  are kept apart on purpose: the implementer-facing contract (`SPEC.md`) names the
  separations and invariants for whoever edits it; `README.md` is for a user installing
  it; `docs/SPEC.md` is user-visible behaviour with no code. Merging them would force one
  audience to read another's detail.
  - `server.ts` — the host entry. The loader resolves `<plugin-root>/server`
    before `<plugin-root>/index` (`.ts` before `.js`), so a directory install
    needs only this one re-export.
  - `src/index.ts` — `setup()`: registers the `context` hook, the `skill_state`
    tool and the `/skillstate` command, and returns the disposer.
  - `src/context.ts` — the transform: inject Σ, collapse the superseded prefix,
    seed, nudge. The heart of the plugin.
  - `src/state.ts`, `src/schema.ts` — the per-session Σ store, and the schema
    plus the `⊕` merge (a `null` value deletes a key; unknown keys are dropped).
  - `src/view.ts` — safe-cut helpers (turn numbering, tool-call/result pairing
    balance) ported from the live reference plugin; the pairing arithmetic is
    not reinvented here.
  - `scripts/smoke.mjs` — the pinning test for the hard rules below.
- `docs/arXiv-2608.26263v2/` — the source paper (LaTeX) the approach is
  derived from. **Read-only reference.** This repo implements the paper's
  context-window idea; it does not re-verify the paper.
- `docs/features/` — the feature map (this workflow).
- `HANDOFF.md` — volatile session state; refreshed at handover, allowed to lag
  the tip (its header says the code wins).

## Commands

Everything runs from the repo root unless said otherwise.

- Install dependencies: `npm install`
- Typecheck (build gate, strict, no emit): `npm run typecheck`  (`npx tsc --noEmit`)
- Smoke test (the pinning test — Σ injection, safe collapse, idempotence, merge
  semantics): `npm run smoke`  (`node scripts/smoke.mjs .`)
- Load the plugin in OpenCode: the host resolves `<plugin-root>/server`, so point
  a discovery directory at this package. Project scope:
  `.opencode/plugin/opencode-skill-state`; user scope:
  `C:\Users\mega\.config\opencode\plugins\`. No build step — the host loads the
  TypeScript source directly.

The gate before a commit is every check, not just the tests:

    npm run typecheck  →  npm run smoke        (run from the repo root)

There is no separate formatter or linter yet; `tsc --noEmit` under
`strict: true` is the strict flag the smoke test runs after. A smoke run alone
will import and execute a module that still fails strict typecheck, so the
typecheck is part of the gate rather than a nicety.

## Workflow
- **The features map is part of the change, not the cleanup.** Before staging a
  commit, update the feature doc(s) for whatever you changed
  (`docs/features/`), and add an index row if the doc is new. User-visible
  behavior also updates `docs/SPEC.md` in the same commit. A docs-only
  follow-up commit is the one that gets skipped. Pure refactors with no
  behavior, mechanism, config or test change need no doc edit — do not churn
  the map.
- **Read the map before the code, and keep the map worth reading.** A feature
  page is an anti-hunting payload: the file, type, function and test names for
  one area, and the traps that cost someone an afternoon. Opening the source
  first and writing the page afterwards spends the tokens twice. If a page is
  wrong, fix it in the same commit rather than working around it — a map
  nobody trusts is worse than no map.
- **Search the map in the same breath as the code.** A grep for a feature, a
  symbol or a behaviour runs over `docs/features/` too: the feature pages name
  the identifiers and the tests, so the page you need is usually one hop from
  the hit.
- **`HANDOFF.md` is refreshed at the end of a session, not per commit.** It
  carries what only the passing session knows — open threads, next steps, the
  last thing delivered — under an `As of` stamp. It is allowed to lag the tip:
  its header says the code wins. Refresh it before you hand the work over.
- **Measure, don't deduce it.** Reading the code and doing the arithmetic in
  your head is how geometry, layout and formatting bugs ship. Print the real
  numbers from the real thing — a headless run, a scratch script, the actual
  command — and assert both the good and the broken case, so each test carries
  its own failure mode.
- **Gate on the whole check set, not just the tests.** The linter catches the
  classes of defect the test run compiles straight past. Run the formatting,
  the lint with warnings denied, the tests and the build before you call
  something done.
- **Commit messages go through a file.** Write the message to a scratch file
  (this machine uses `%LOCALAPPDATA%\Temp\opencode\<project>-commit-msg.txt`)
  and run `git commit -F <path>`; a PowerShell here-string gets its terminator
  mangled by the shell tool.
- **No AI attribution in a commit message, ever, without being asked.** No
  `Co-Authored-By` trailer, no `Generated with` footer, nothing that reads as
  crediting a model or tool. These commits are the user's. This is enforced,
  not merely preferred: a machine-wide `commit-msg` hook
  (`core.hooksPath` = `C:/Users/mega/.githooks`) rejects the commit outright,
  and it blocks human co-authors too, so the only ways past it are `--no-verify`
  or `ALLOW_COAUTHOR=1`. **Use neither without the user asking in that
  conversation.** If the hook blocks something, report it and stop; do not
  reword the message to slip a trailer past the pattern.
- **Package after committing.** If the version is derived from the commit
  (a count since a base tag, a stamped build number), packaging first yields
  the previous commit's number. Raise the minor and the base together, in the
  same commit, and keep every reader of that number reading it from one place.
- **Do not commit before the user has looked at it.** Hand a visual change over
  as a build and wait for confirmation.

## Where the working knowledge lives

The per-feature working knowledge lives in `docs/features/`; its `README.md` is
the index. This file keeps the process rules and the hard rules that apply
across features; the feature pages keep the maps, mechanisms and traps.

## Hard rules

- **The context pass never mutates the durable transcript.** It only rewrites the
  outbound payload (`event.messages` / `event.system`) one action boundary at a
  time, and re-applies from scratch on every request because the host rebuilds the
  raw transcript each time. *Reason:* mutating the transcript corrupts the very
  session the transform only summarises. *Pinned by:* the smoke test's idempotence
  assertion — running the transform twice yields the identical payload.
- **Never split a tool call from its result, and never inject while a call is open
  at the tail.** Collapse happens only at safe turn boundaries from `balanceCuts`
  (`src/view.ts`); a state or notice message is appended only when `inFlight === 0`.
  *Reason:* the host must pair every `tool-call` with its `tool-result`; a cut or
  insert between them makes the host invent a result and the model then see two
  answers for one call. *Pinned by:* the smoke assertion that no call/result pair is
  split.
- **The runtime owns the schema, not the model.** The `⊕` merge (`src/schema.ts`)
  deletes a key when the patch sets it to `null`, drops keys not in the schema, and
  replaces arrays wholesale. *Reason:* the paper's failure modes are the model
  dropping or overwriting existing keys; schema ownership in the deterministic
  runtime is what keeps a malformed patch from corrupting Σ. *Pinned by:* the merge
  unit test (null-delete, unknown-key-drop).
- **The product is the repo root.** Only `docs/` and the untracked paper are not
  deployed, and never edit the reference plugin** at
  `C:\Users\mega\.config\opencode\plugins\opencode-feature-map-as-context`.
  *Reason:* that plugin is a live dependency of this host and the measured ground
  truth for the plugin API; changing it silently changes both. *Pinned by:* review
  only — there is no automated check, so treat it as a review gate.

- The README is for users. Implementation detail belongs in `docs/SPEC.md` for
  behavior and here for working knowledge, and the user must be consulted
  before technical detail is added to the README.
