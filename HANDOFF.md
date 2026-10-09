# Session handoff — opencode-g-skill-state

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-10` — `master` carries v0.1, v0.2, the paper-untrack commit and the
flatten. `2026-10-09` was v0.1.

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

## Open threads

- **(done) Commit v0.2** — it is on `master` (`c15c38e`), committed through the `commit-msg`
  hook with no AI attribution, as `AGENTS.md` requires.
- **Live end-to-end run** inside a real OpenCode session — the smoke test drives a fake
  *host*, not this one. The load path itself is already proven live: the junction resolves
  `<repo>/server` and this session's `/skillstate` command works, which is the discovery and
  registration half. What is still unproven is a real collapse firing against the live
  harness's **actual** payload (the token count there is the one the smoke only models).
  Just keep talking; `/skillstate` prints the per-turn index showing what collapsed.
- **(answered) Install target** — project scope won. The live install is
  `.opencode/plugin/opencode-skill-state`, a **junction to the repo root**, not a copy;
  the user-scope directory `~/.config/opencode/plugins/opencode-skill-state` never
  existed. See the junction trap in **State** above before moving this repo.
- Not implemented from `HOST-API-NOTES.md`: `ctx.event.subscribe` idle flush,
  `ctx.session.synthetic` durable turn, `Message.system()` injection role.
- Optional: a token/percentage-gated collapse trigger alongside the turn-count gate
  (`min` is turn-count, per `docs/SPEC.md`).

## Known gaps (volatile; the durable traps live in the feature pages)

- No live OpenCode run — only the isolated smoke test has executed both seams.
- Native (provider-side) compaction bypasses the compaction hook's message edits; the
  plugin's `event.result` still applies because `event.messages` is never edited.
- A record captures the storage handle at creation, so one process has one store.

## Local-only state (not on the remote)

- No remote configured. The reference plugin consulted
  (`~/.config/opencode/plugins/opencode-feature-map-as-context`) is outside this repo and
  was not modified.
