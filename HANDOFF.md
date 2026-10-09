# Session handoff — opencode-g-skill-state

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of HEAD (see `git log -1`) — `2026-10-09`.

## State

- **Repo initialized on `master` and v0.1 committed** — root commit, working tree
  clean, 39 files / ~11.9k insertions. The commit message was written to a scratch
  file and passed through the machine-wide `commit-msg` hook (no AI attribution), per
  `AGENTS.md`. No remote is configured yet.
- **The plugin is built and verified** at `opencode-skill-state/`. Gate green under an
  independent run: `npm run typecheck` (strict, `--noEmit`) clean; `npm run smoke` → ok.
  Measured: outbound 61 → 14 messages, 15406 → 3642 tokens (76% saved on a 128k window),
  idempotent (byte-identical), pairs never split, `⊕` merge semantics correct. All four
  `AGENTS.md` hard rules hold (durable transcript untouched; safe-boundary + balanced-tail;
  runtime owns the σ-schema; nothing outside `opencode-skill-state/` changed, the reference
  plugin untouched).
- Docs are consistent and committed: `AGENTS.md`, `docs/SPEC.md` (settings reconciled to the
  real `options.json`), the feature map (`docs/features/{README,context-collapse,skill-state,skill-state-controls}.md`)
  with real symbols + smoke-test pins, and this file. `opencode-skill-state/HOST-API-NOTES.md`
  is the build-side host-API reference; `opencode-skill-state/SPEC.md` the design contract.

## Open threads

- **Integrate the `lib-1` upgrades (the real SKILL.state distillation).** Two additive passes,
  specced in `opencode-skill-state/HOST-API-NOTES.md` "Integrate next":
  1. durable Σ via `ctx.storage` (+ in-memory LRU cache) so state survives restart;
  2. a `ctx.session.hook("compaction", …)` that distils `event.messages` → Σ, persists it, and
     sets `event.result = { summary: render(Σ) }` — skipping the host's summary model call.
  After that: update `docs/features/skill-state.md`'s persistence trap + `docs/SPEC.md`'s
  "does not" list, re-run the gate, and bump the version (a repo/commit count now exists to
  key any derived version from, per `AGENTS.md`).
- **Live end-to-end run** inside a real OpenCode session (the smoke test drives the transform
  in isolation; it is not the live host). Requires the user's OK to install into a discovery dir.
- **Install target** — project `.opencode/plugin(s)/` vs this user's `~/.config/opencode/plugins/`.
  **Ask the user; installing changes the running OpenCode.**
- Optional: a token/percentage-gated collapse trigger alongside the turn-count gate
  (`min` is currently turn-count, per `docs/SPEC.md`).

## Known gaps (volatile; the durable traps live in the feature pages)

- No live OpenCode run — only the isolated smoke test has executed the transform.
- Σ is in-memory; restart re-expands to the raw transcript (the `ctx.storage` upgrade fixes this).
- The `compaction`-hook distillation and durable storage are **not** in shipped v0.1.

## Local-only state (not on the remote)

- No remote configured. The reference plugin consulted
  (`~/.config/opencode/plugins/opencode-feature-map-as-context`) is outside this repo and
  was not modified.
