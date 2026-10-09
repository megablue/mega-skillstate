# Session handoff — opencode-g-skill-state

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-10` (working tree, v0.2 not yet committed) — `2026-10-09` was v0.1.

## State

- **v0.1 committed on `master`** — root commit, clean tree, 39 files / ~11.9k insertions.
  No remote configured yet. v0.2 is built and verified but **uncommitted**.
- **v0.2 adds the two `lib-1` seams** from `HOST-API-NOTES.md` "Integrate next":
  - **durable Σ** — `ctx.storage`, key `state/<sessionID>`, in-memory LRU (`MAX_SESSIONS = 64`)
    as a write-through cache. Reads async (a miss is one `storage.get`), the `⊕` merge stays
    synchronous, degradation to in-memory on any store failure (never throws).
  - **owning compaction** — `ctx.session.hook("compaction")` via `src/compaction.ts`.
    Deterministic distillation (persisted Σ + whole-transcript seed sweep, holes only),
    `event.result = { summary: stateMessageText(Σ, span) }`, **no model call**, and
    `result` left unset when `hasMeaningfulState` is false. `event.messages` read-only.
- **Gate green**: `npm run typecheck` (strict, `--noEmit`) clean; `npm run smoke` → ok.
  The original numbers are unchanged (61 → 14 messages, 15406 → 3642 tokens) and the smoke
  now also pins the durable write, the restart, the compaction path and its guard, the
  no-store and broken-store degradations.
- **New module `src/compaction.ts`**; `src/state.ts` is now async and durable; `src/seed.ts`
  gained `seedHintsFromMessages` (whole transcript) beside `seedHints` (the kept window).
- Docs updated in the same change: `docs/SPEC.md` (new **Compaction** section; the
  "Σ lives in memory" bullet removed), `docs/features/` (new `compaction.md` + its index row;
  `skill-state.md` persistence trap replaced; `context-collapse.md` and
  `skill-state-controls.md` re-pointed at the async/durable surfaces), this file.

## Open threads

- **Commit v0.2** — `git commit -F <scratch>` through the `commit-msg` hook, no AI
  attribution (see `AGENTS.md`). Nothing staged or committed by the implementing session.
- **Live end-to-end run** inside a real OpenCode session — the smoke test drives a fake host,
  not the live one. Requires the user's OK to install into a discovery dir.
- **Install target** — project `.opencode/plugin(s)/` vs this user's `~/.config/opencode/plugins/`.
  **Ask the user; installing changes the running OpenCode.**
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
