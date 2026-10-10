# Session handoff — opencode-g-skill-state

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-10`, **end of session** — `master` is **clean at this tip**: this
refresh ← `d0665d6` (the `state_patch` string fix) ← `093abb2` (installer copies)
← `5fa1ea4`
(Σ log keys as maps + shape-naming hints) ← `528ff7d` (user config bootstrap) ←
`525277a` ← `27f45d4` ← `a7b2acf` (install/uninstall) ← `983b877` (package
flattened) ← `b15fc35` (paper untracked) ← `c15c38e` (v0.2) ← `ab08b26` (v0.1).
`2026-10-09` was v0.1. `git rev-parse HEAD` for the sha — this file does not
name itself, because amending the fill-in would rewrite it again.

## State

- **The `state_patch` fix (`d0665d6`) — the fix a live session needed.** The
  host validates `skill_state`'s arguments against `TOOL_INPUT` **before**
  `execute` runs, so a patch that arrived as a JSON string was refused with
  `Invalid arguments for tool "skill_state": - state_patch: Expected object` and
  the plugin never saw it; the guard inside `execute` was unreachable. A
  previous session looped on that refusal for about an hour (31 stringified
  calls in one stretch), because the message read like a size problem and the
  model retried smaller patches. Now `state_patch` is `["object","string"]`,
  `parsePatch` unfences and decodes a string, requires a plain object, refuses
  anything else softly, and the ack appends a note when a string had to be
  parsed. Map, mechanism and trap: `docs/features/skill-state-controls.md`;
  contract: `DESIGN.md` → `skill_state` tool; user-visible line:
  `docs/SPEC.md` → Controls.
- **Why the union is safe (measured, not assumed).** The host converts the raw
  JSON Schema through effect's importer (decoded from `opencode.exe`), and this
  repo's dev dependency carries the same effect line (`4.0.0-rc.112`).
  `temp/probe-json-schema.mjs` (ignored) imported the exact `TOOL_INPUT` and
  decoded both forms, refusing arrays and numbers with `Expected object |
  string`. The smoke pins the rest — rows `state_patch as string`,
  `state_patch fenced`, `state_patch refusals`.
- **The restart check is closed — verified live.** The user installed both
  scopes and restarted; the first stringified `state_patch` through the real
  call path landed as `skill-state updated → step 74 (changed: findings, step)`
  with the ack's `note: state_patch arrived as a JSON string; the runtime parsed
  it. Pass the object itself next time.` The union schema registered at host
  load — the description-only fallback was not needed — and the refusal class
  that looped the previous session is gone.
- **Install state, true as of this refresh — both scopes, each a copy.**
  `plugin:status` this session: project
  `.opencode/plugin/opencode-g-skill-state` and user
  `~/.config/opencode/plugins/opencode-g-skill-state`, both "a copy of the
  shipped set, 18 file(s), in sync with the repository". The project scope's
  junction became a copy in the previous session; the user scope was installed
  right after this session's fix, so every project runs the fix. `opencode
  plugin list` shows a row per scope for this repo — expected, the context pass
  is idempotent by design; if anything ever doubles visibly, uninstall one
  scope. Copy semantics and junction-safe removal:
  `docs/features/skill-state-controls.md` → Install & uninstall.
- **Everything older stands as verified:** the v0.2 seams (durable Σ,
  compaction) with the gate numbers unchanged (61 → 14 messages, 15406 → 3642
  tokens), the live restart proving the durable store, and the
  log-keys-as-maps change (`skill-state.md` → the schema hints). This session's
  fix is behaviour-additive; every older smoke pin still passes unchanged.

## Open threads

- Compaction end-to-end is still unproven live (the smoke drives a fake host).
- **Map sizing (deferred).** `docs/features/configuration.md` → `## How & why`
  (2.4 KB) and `docs/features/skill-state-controls.md` → `## How & why`
  (6.2 KB, largest chunk 3.5 KB) exceed the ~2 KB single-read guidance;
  `feature_map_regen` can split them. Deliberately not run this session to
  keep the diff scoped.
- Not implemented from `HOST-API-NOTES.md`: `ctx.event.subscribe` idle flush,
  `ctx.session.synthetic` durable turn, `Message.system()` injection role.
- Optional: a token/percentage-gated collapse trigger alongside `min`.

## Known gaps (volatile; the durable traps live in the feature pages)

- `opencode plugin list` printed a stale row once; it was the running server's
  in-memory resolution, not config or disk — a **restart** clears it, not an
  edit. The rename plus this session's reinstall make it unreproducible.
- Native (provider-side) compaction bypasses the compaction hook's message
  edits; the plugin's `event.result` still applies because `event.messages` is
  never edited.
- A record captures the storage handle at creation, so one process has one
  store.
- The feature-map index once carried duplicate rows; the check is to `git grep`
  a feature name over `docs/features/README.md` — two hits means it is back.

## Local-only state (not on the remote)

- No remote configured. The reference plugin
  (`~/.config/opencode/plugins/opencode-feature-map-as-context`) is outside this
  repo and was not modified.
- `~/.config/opencode/g-skill-state.json` exists (362 bytes, the defaults,
  verified deep-equal; only `trackTools` formatting differs from
  `options.json`). Keep it — a delete just gets it rewritten on the next load.
- Both scopes are installed as copies, in sync (see State).
- `temp/` is ignored (this session): it holds `probe-json-schema.mjs` and the
  user's `invalid_tool_calls.txt` evidence dump (the five `Expected object`
  refusals plus the successful call behind the diagnosis). Working artifacts;
  do not track them.
