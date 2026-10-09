# Session handoff — opencode-g-skill-state

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-10`, **end of session** — `master` is `a7b2acf` ← `983b877` ← `b15fc35` ←
`c15c38e` (v0.2) ← `ab08b26` (v0.1). `2026-10-09` was v0.1. `b15fc35` untracked the paper;
`983b877` flattened the package; `a7b2acf` added install/uninstall. The first two are
structural: no behaviour was meant to change, and the pinning numbers confirm it.
The working tree is **clean at the tip** — `a7b2acf` is the last thing delivered.

## State

- **Everything is on `master`.** v0.1 (root commit), v0.2 (the two `lib-1` seams below),
  then `b15fc35` untracked the paper and the package was **flattened to the repo root**.
- **The package is the repo root** — `src/`, `scripts/`, `server.ts`, `options.json`,
  `package.json`, `tsconfig.json` and the four docs all sit at the top level now; the old
  `opencode-skill-state/` subdirectory is gone. The plugin keeps its **id**
  `opencode-skill-state` (package name, `plugin.default.id`, `~PLUGIN`); only path-shaped
  references changed. The README's install instruction is a `robocopy` of the shippable
  subset (`*.ts *.json *.md`, excluding `node_modules docs .git .opencode`), because
  "copy this directory" would now mean the whole repo, paper and `.git` included.
- **The live install is a junction, and that is the trap.** `.opencode/plugin/
  opencode-skill-state` is `LinkType=Junction` pointing at the **repo root**. It used to
  point at the nested package directory, so a session that flattens must repoint it — and
  repoint it *before* deleting the old directory. Delete a junction with
  `(Get-Item $link).Delete()`; never `Remove-Item -Recurse`, which can recurse through the
  link and delete the target's contents. The user-scope directory
  (`~/.config/opencode/plugins/opencode-skill-state`) never existed.
- **Install and uninstall now exist** — `scripts/install.ts` (252 new lines) plus four
  `plugin:*` npm scripts, ported from the reference plugin's contract rather than invented:
  one script, three modes, scope chosen by flag. Default = **user scope**
  (`~/.config/opencode/plugins`), `--project` = **project scope** (`.opencode\plugin`, where
  the live install already is), `--remove` = uninstall, `--status` prints both scopes. The
  whole design turns on one Windows hazard: `rmSync` must be called **without `recursive`**
  on a link, so a delete can never recurse through the junction and destroy the repo.
  Idempotent (`already current` / `replaced`) and `readlinkSync`-aware, so a **stale**
  junction is replaced rather than left dead.
  `files[]` was also wrong: it omitted `scripts/`, so an installed copy could not run its own
  installer. Now `server.ts, src, scripts, options.json, README.md`.
- **The installer was verified by running it, not by reading it.** `plugin:status` prints
  `project <repo>\.opencode\plugin -> <repo root>` and `user … (not installed)`.
  `plugin:install:project` run **twice** is idempotent — the second run prints `already
  installed in project scope` and touches nothing. The junction resolves `server.ts` through
  it (`Test-Path` → True). Node **v22.23.2** executes `.ts` natively (a type-stripping probe
  printed `ts-ok`), so no build step is involved. One correction recorded on purpose: an
  earlier claim that `--status` mislabels the project line is **false** — the line reads
  `project <path> -> <target>`, and the `.opencode\plugin` path segment was mistaken for a
  label.
- **v0.2 adds the two `lib-1` seams** from `HOST-API-NOTES.md` "Integrate next":
  - **durable Σ** — `ctx.storage`, key `state/<sessionID>`, in-memory LRU (`MAX_SESSIONS = 64`)
    as a write-through cache. Reads async (a miss is one `storage.get`), the `⊕` merge stays
    synchronous, degradation to in-memory on any store failure (never throws).
  - **owning compaction** — `ctx.session.hook("compaction")` via `src/compaction.ts`.
    Deterministic distillation (persisted Σ + whole-transcript seed sweep, holes only),
    `event.result = { summary: stateMessageText(Σ, span) }`, **no model call**, and
    `result` left unset when `hasMeaningfulState` is false. `event.messages` read-only.
- **Gate green from the flattened root**: `npm run typecheck` (strict, `--noEmit`) clean and
  `npm run smoke` → ok, both re-run after the flatten. The pinning numbers are unchanged
  (61 → 14 messages, 15406 → 3642 tokens) and the smoke still pins idempotence, the
  durable write, the restart, the compaction path and its guard, and the no-store and
  broken-store degradations — so the flatten is behaviour-neutral, as it should be.
- **New module `src/compaction.ts`**; `src/state.ts` is now async and durable; `src/seed.ts`
  gained `seedHintsFromMessages` (whole transcript) beside `seedHints` (the kept window).
- Docs updated in the same change: `docs/SPEC.md` (new **Compaction** section; the
  "Σ lives in memory" bullet removed), `docs/features/` (new `compaction.md` + its index row;
  `skill-state.md` persistence trap replaced; `context-collapse.md` and
  `skill-state-controls.md` re-pointed at the async/durable surfaces), this file.
- **Both commits are behaviour-neutral and measured so.** `git ls-files` is 30 (41 minus the
  11 paper files); `node_modules` and the paper are ignored; zero untracked files. The
  junction repoint was verified by resolving `server.ts` through it (`Test-Path` → True), not
  by assuming the link worked.
- **A trap worth naming: the live install is a junction, so a structural move can break
  discovery without touching code.** `.opencode/plugin/opencode-skill-state` points at the
  repo root now; before the flatten it pointed at the nested package directory. See the
  junction bullet at the top of this section — repoint before deleting, never recurse.

## Open threads

- **(done) Commit v0.2** — it is on `master` (`c15c38e`), committed through the `commit-msg`
  hook with no AI attribution, as `AGENTS.md` requires.
- **(done) Installer** — `a7b2acf` on `master`. The install-uninstall work this session was
  about is delivered, verified by running it, and the smoke test pins the junction-safe
  removal. The `opencode plugin list` stale row below is *not* a reason to touch it.
- **Live end-to-end run** inside a real OpenCode session — the smoke test drives a fake
  *host*, not this one. The load path itself is already proven live: the junction resolves
  `<repo>/server` and this session's `/skillstate` command works, which is the discovery and
  registration half. What is still unproven is a real **compaction** firing against the live
  harness's actual payload, and the token count the smoke only models there. The **collapse**
  seam has now fired live: `/skillstate` printed the per-turn index and forced a collapse
  mid-session, and the plugin-injected Σ state message was rendered in the live request. Keep
  talking; `/skillstate` prints the index showing what collapsed.
- **(answered) Install target** — project scope won. The live install is
  `.opencode/plugin/opencode-skill-state`, a **junction to the repo root**, not a copy;
  the user-scope directory `~/.config/opencode/plugins/opencode-skill-state` never
  existed. See the junction trap in **State** above before moving this repo.
- The installer has **no uninstall for the user scope** in practice — running
  `plugin:uninstall` targets `~/.config/opencode/plugins`, where nothing was ever installed,
  so the project-scope junction is the thing to remove and it needs
  `plugin:install --project --remove` or the junction's `(Get-Item $link).Delete()`.
  A `--remove --project` invocation was not exercised; that is the one untested branch.
- Not implemented from `HOST-API-NOTES.md`: `ctx.event.subscribe` idle flush,
  `ctx.session.synthetic` durable turn, `Message.system()` injection role.
- Optional: a token/percentage-gated collapse trigger alongside the turn-count gate
  (`min` is turn-count, per `docs/SPEC.md`).

## Known gaps (volatile; the durable traps live in the feature pages)

- **The collapse seam has now fired live; only compaction is unproven end-to-end.**
  `/skillstate` was run in this live session and printed the per-turn index and forced a
  collapse, which proves the `context` hook, Σ injection and safe collapse all run against
  the real host — not the smoke test's fake host. The compaction hook
  (`ctx.session.hook("compaction")`) has been exercised only by the smoke test. What
  remains unproven live is a host-initiated compaction reaching `src/compaction.ts`, and
  the real token figures (the smoke numbers are a model, not a measurement of this host).
- Native (provider-side) compaction bypasses the compaction hook's message edits; the
  plugin's `event.result` still applies because `event.messages` is never edited.
- A record captures the storage handle at creation, so one process has one store.
- **The feature-map index has duplicate rows.** `docs/features/README.md` listed Context
  collapse, Σ store & schema, and skill_state & /skillstate **twice** — rows 19–22 and
  rows 23–25 differ only by one word ("a tool registered" vs "a tool that is registered").
  Fixed on `2026-10-10`: the duplicate block was removed and the surviving `skill_state` row
  gained the install/uninstall trigger. The check that finds it is `git grep` a feature name
  over the index — two hits means it came back.
- **`opencode plugin list` prints a stale row, and nothing on disk is wrong.** After the
  flatten it showed `opencode-skill-state` → `…/opencode-g-skill-state/opencode-skill-state/
  server.ts`, a directory that no longer exists. Searched on `2026-10-10`: **no config,
  state, cache or database file holds it.** `~/.config/opencode/` has zero hits;
  `opencode.db` has no plugin-registry table (its only plugin-named row is this plugin's own
  `kv` state, from `src/state.ts`); `opencode.json`'s `plugins` array is only
  `//@tarquinen/opencode-dcp@latest` and `oh-my-opencode-slim`. The string survives only in
  `~/.local/share/opencode/log/opencode.log` (a log) and in the **running server's
  in-memory resolution** — the server had not re-scanned since the `git mv`. Clearing the
  row is therefore an `opencode` **server restart**, not a config edit, and the junction is
  already correct. Do not go hunting for it again.

## Local-only state (not on the remote)

- No remote configured. The reference plugin consulted
  (`~/.config/opencode/plugins/opencode-feature-map-as-context`) is outside this repo and
  was not modified.
