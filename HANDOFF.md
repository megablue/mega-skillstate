# Session handoff — mega-skillstate

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-10`, **end of session** — the tip is the rename commit
(`Rename the project to mega-skillstate`) on top of `d0665d6` (the
`state_patch` string fix) ← `093abb2` (installer copies) ← `5fa1ea4` (Σ log
keys as maps + shape-naming hints) ← `528ff7d` (user config bootstrap) ←
`525277a` ← `27f45d4` ← `a7b2acf` (install/uninstall) ← `983b877` (package
flattened) ← `b15fc35` (paper untracked) ← `c15c38e` (v0.2). `git rev-parse
HEAD` for the sha — this file does not name itself, because amending the
fill-in would rewrite it again.

## State

- **The rename — every surface in this repo now says `mega-skillstate`.**
  Package name, plugin id (`PLUGIN`, so the message label too), repository
  URL, README title and Version badge, `@module` tags, docs and smoke pins;
  version `0.3.0`. The user-level config surface moved with it:
  `~/.config/opencode/mega-skillstate.json` and `MEGA_SKILLSTATE_CONFIG`
  (clean break, no fallback aliases). The pre-rename file was renamed in
  place, so its edits survive — it carries one entry beyond the defaults,
  `feature_map` in `trackTools`.
- **Injected ids are now `mega_`-prefixed** (`mega_state`,
  `mega_notice_stale`; `src/view.ts` `INJECTED_ID_PREFIX`). The reference
  plugin keeps its own `fmac_` prefix, and `HOST-API-NOTES.md` still names
  that — the only remaining `fmac` mentions in the repo.
- **Install scopes — reinstalled under the new name this session.** The
  old-named copies were removed from both scopes first (so no restart can
  discover both ids), then: project `.opencode/plugin/mega-skillstate`,
  user `~/.config/opencode/plugins/mega-skillstate`, both "a copy of the
  shipped set, 18 file(s), in sync with the repository". `opencode plugin
  list` shows a row per scope for this repo — expected, the context pass is
  idempotent by design; if anything ever doubles visibly, uninstall one
  scope.
- **The folder rename is pending — the one live step.** The repo directory
  is still `opencode-g-skill-state`. `Rename-Item` was refused with "being
  used by another process": the running host holds the directory as its
  cwd, and Windows will not rename it underneath. Rename it with OpenCode
  not running in it (close OpenCode, or start from another directory):
  `Rename-Item C:\Users\mega\projects\opencode-g-skill-state mega-skillstate`,
  then reopen OpenCode in `C:\Users\mega\projects\mega-skillstate`. The
  repo, `.git` and the project-scope copy all move together; nothing else
  needs redoing. This session (still keyed to the old path) can be moved
  with `session_move` from a new session afterwards.
- **Restart pending — the rename's live check.** After the restart watch
  for: the plugin loading as `mega-skillstate`, the injected message id
  `mega_state`, the config bootstrap at `mega-skillstate.json`, and
  `/skillstate` still working.
- **The `state_patch` fix (`d0665d6`) — the fix a live session needed.**
  The host validates `skill_state`'s arguments against `TOOL_INPUT`
  **before** `execute` runs, so a patch that arrived as a JSON string was
  refused with `Invalid arguments for tool "skill_state": - state_patch:
  Expected object` and the plugin never saw it; the guard inside `execute`
  was unreachable. A previous session looped on that refusal for about an
  hour (31 stringified calls in one stretch), because the message read like
  a size problem and the model retried smaller patches. Now `state_patch`
  is `["object","string"]`, the string is unfenced and decoded, must be a
  plain object, anything else is refused softly, and the ack appends a note
  when a string had to be parsed. Map, mechanism and trap:
  `docs/features/skill-state-controls.md`; contract: `DESIGN.md` →
  `skill_state` tool; user-visible line: `docs/SPEC.md` → Controls.
- **Why the union is safe (measured, not assumed).** The host converts the
  raw JSON Schema through effect's importer (decoded from `opencode.exe`),
  and this repo's dev dependency carries the same effect line
  (`4.0.0-rc.112`). `temp/probe-json-schema.mjs` (ignored) imported the
  exact `TOOL_INPUT` and decoded both forms, refusing arrays and numbers
  with `Expected object | string`. The smoke pins the rest — rows
  `state_patch as string`, `state_patch fenced`, `state_patch refusals`.
  The rest of this bullet's earlier live check stands: the union schema
  registered at host load, and a real stringified call came back parsed.
- **Everything older stands as verified:** the v0.2 seams (durable Σ,
  compaction) with the gate numbers unchanged (61 → 14 messages, 15406 →
  3642 tokens), the live restart proving the durable store, and the
  log-keys-as-maps change (`skill-state.md` → the schema hints).

## Open threads

- **Folder rename** (see State) — needs OpenCode off the directory.
- **Post-restart rename check** — `mega_state` ids, `/skillstate`, and no
  `g-skill-state.json` reappearing in `~/.config/opencode/`.
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
- `~/.config/opencode/mega-skillstate.json` — renamed from
  `g-skill-state.json` this session; keep it (one custom entry:
  `feature_map` in `trackTools`; a delete just gets it rewritten on the next
  load).
- Both scopes are installed as `mega-skillstate` copies, in sync (see State);
  the old-named install directories are gone.
- The repo folder rename is pending (see State) — until then the working
  directory is still `C:\Users\mega\projects\opencode-g-skill-state`.
- `temp/` is ignored: it holds `probe-json-schema.mjs` and the user's
  `invalid_tool_calls.txt` evidence dump (the five `Expected object` refusals
  plus the successful call behind the diagnosis). Working artifacts; do not
  track them. This session's rename sweep script lives outside the repo, in
  `%LOCALAPPDATA%\Temp\opencode\`.
