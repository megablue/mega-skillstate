# Configuration — sources, the ladder, and the bootstrap

Status: shipped (v0.2) · Read when: a setting does not take effect; where a config
value comes from; the user-level `mega-skillstate.json`; which file wins; the plugin
writing a config file on first run; an unknown key refusing to load; the smoke test
touching the real home.

## What it does

- Three sources, layered most specific last: the built-in `DEFAULT_CONFIG`, the
  `options.json` an installed copy carries, the user-level
  `~/.config/opencode/mega-skillstate.json`, and the host's own plugin entry in
  `opencode.json`. A source replaces only the keys it sets, so a partial file is a
  valid file.
- A **first run writes every default** to the user-level file, pretty-printed. An
  existing file is the user's own and is never rewritten — edits survive.
- A **malformed file or an unknown key is an error**: the plugin refuses to load
  rather than quietly keeping a default. A **failed write only warns**: a home
  that cannot be written must not keep the plugin from loading.

## Map

- `src/config.ts` — `DEFAULT_CONFIG` (the 12 keys), `userConfigPath()`,
  `ensureUserConfig()`, `readJsonFile()`, `objectLayer()`,
  `resolveOptions(hostOptions, optionsFile?, userFile?)` (the layered merge),
  `resolveConfig` (strict, per-key fallback to the default), `resolveThresholds`.
- `src/index.ts` — `OPTIONS_PATH` (`../options.json` beside `src/`); `setup` calls
  `userConfigPath()`, then `ensureUserConfig()`, then
  `resolveConfig(resolveOptions(ctx.options, OPTIONS_PATH, userFile))` — the only
  call site.
- `scripts/smoke.mjs` — the `user config` / `config layers` rows: the redirected
  `MEGA_SKILLSTATE_CONFIG` scratch file, the defaults written, the
  never-rewrite proof, the ladder order, the malformed-file refusal.

## How & why

- **Why a user-level file at all.** An install that is only a directory under
  `~/.config/opencode/plugins/` is loaded with no host entry (measured on the
  reference plugin), so `options.json` inside the copy is the only file it reads.
  With the old junction install that file *was the repository's*, so a per-user
  setting had to be committed; with a copy install it is a copy, so a setting
  edited into it is overwritten by the next reinstall. Either way the user-level
  file is the layer that is neither: per-user, never committed, surviving an
  install, and outranking the copy's `options.json`.
- **The ladder, key by key.** A later layer overwrites only the keys it sets; the
  rest fall through to the layer below. The shipped `options.json` lists all 12
  keys, so the merge changes no behaviour today — it becomes true layering the
  moment someone trims that file or ships a partial one.
- **The drift trap.** `.opencode/plugin/mega-skillstate` is a *copy* of the shipped
  set, so editing the repository's `options.json` no longer changes the live plugin for any
  project — the install keeps its own copy until a reinstall syncs it. That is the trap
  under copy semantics: an edit in the repository reaches nothing until
  `npm run plugin:install` runs and OpenCode restarts, and `--status` names the drift
  (files missing, changed, extra) rather than leaving you to deduce it. The user-level file
  outranks the installed copy, which is the point: it is per-user, never committed, and
  survives an install.
- **Why a failed write warns and never throws.** The file is a convenience — the
  layers fall through to the defaults without it. A *missing* file is not an
  error; a *malformed* one is, like every other configuration mistake.
- **The env seam.** `MEGA_SKILLSTATE_CONFIG` overrides the path — for the
  smoke test, which must never write to a real home, and for a user who wants the
  file somewhere else. It is read when `setup` runs, not at import, so a test can
  redirect per call.
- **Two behaviors changed by design, and they are the ones to watch.** Host
  options used to win *outright*, ignoring `options.json` entirely; they now win
  *per key*. And `setup` now writes a file it did not used to write. The first is
  behaviour-neutral only because the shipped `options.json` equals the defaults;
  a partial `options.json` now contributes, where before it was ignored.

## Config keys / UI

The 12 keys and their defaults are documented per feature — see **Related** below
for the page that owns each. This page owns only where a value comes from:
`DEFAULT_CONFIG` < `options.json` < `~/.config/opencode/mega-skillstate.json` < the
host's plugin entry.

## Tests that pin it

`scripts/smoke.mjs` — the **user config** row: the bootstrap write deep-equals
`DEFAULT_CONFIG`, and a second setup never rewrites it. The **config layers** row:
`keepRecentTurns: 2` in the user file beats `options.json`'s 4 (payload 8), the
host entry's 5 beats the user file's 2 (payload 17), and a malformed file is
rejected with `/is not JSON/`.

## Related

- [context-collapse.md](context-collapse.md) — the keys the transform reads
  (`min`, `keepRecentTurns`, `collapseOlder`, `protectFirstUserMessage`,
  `allowSubagentSessions`, `nudgeWhenStale`, `staleAfter`, `debug`).
- [skill-state.md](skill-state.md) — `seedFromTools`, `trackTools`, `debug`.
- [skill-state-controls.md](skill-state-controls.md) — `enabled`,
  `nudgeWhenStale`, `staleAfter`, `manualCommand`.
- [compaction.md](compaction.md) — `enabled`, `collapseOlder`, `seedFromTools`,
  `trackTools`, `debug`.
