# Session handoff — mega-skillstate

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-13`, the tip is `17d2c52` (the options-path fix) — `git rev-parse
HEAD` for the sha; this file does not name itself, because amending the
fill-in would rewrite it again. `main` is **ahead of `origin/main` by 2**:
`9a9b0d6` (Phase 2 design) and `17d2c52` are both local-only.

## State

- **Phase 1 (the core extraction) is complete and pushed.**
  `9a2be0a` split the host-free core from the OpenCode glue: `src/core/`
  (`config`, `compaction`, `prompts`, `schema`, `seed`, `state`, `types`,
  `view`, plus new `ports.ts` declaring the six ports) and
  `src/adapters/opencode/` (`index`, `context`, `tool`, `command`, `types`,
  `config`). `server.ts` re-exports `./src/adapters/opencode/index.ts`. The
  smoke loads `server.ts` exactly as the host resolves it, so the CI loading
  path is what smoke exercises. Behaviour is unchanged and *proven* unchanged:
  `fixtures/golden.json` (captured pre-move, 8 cases) replays byte-for-byte —
  collapse-default still 61 → 14 messages, 15406 → 3642 tokens.
- **Phase 2 (the Pi adapter) is designed and committed locally** (`9a9b0d6`,
  `docs/ROADMAP.md` → Phase 2 section). The verified API read: entry = an
  `ExtensionFactory`; `context` event gives a rewrite-by-return collapse;
  `registerTool` / `registerCommand` (both return void, `on()` returns the
  unsubscribe); `appendEntry` + `sessionManager.getBranch()` on `session_start`
  is a branch-aware, resume-safe Σ store; `before_agent_start` for the standing
  policy; `session_before_compact` returns `{cancel, compaction}`; `ui.notify`
  is the /skillstate reply channel. The adapter forces the deferred glue split:
  `core/context.ts`, `core/skill-state.ts`, `core/skill-state-command.ts`.
  **Three shapes are still unverified** and must be read from the pi source
  before any code: (a) `ui.notify`'s location (likely `ctx.ui`), (b)
  `ToolDefinition`'s executable signature, (c) the Pi package manifest fields.
- **The `OPTIONS_PATH` off-by-one is found, fixed and pinned** (`17d2c52`).
  The core extraction left the adapter two directories deeper than the old
  `src/`, and `OPTIONS_PATH` still resolved `../../options.json` — landing on
  `src/options.json`, which does not exist. It was latent because a missing
  layer is *nothing at all* to the merge and the shipped `options.json` equals
  `DEFAULT_CONFIG` key for key, so no payload moved and no row noticed. Once
  installed, an edited shipped `options.json` would have been silently ignored.
  Now `../../../options.json`, exported, with a new `options path` smoke row
  that asserts the file exists *and* that `resolveOptions` reads its keys.
  This is the depth trap to watch after any future move: grep for
  `fileURLToPath(new URL(` and re-pin.

## Open threads

- **The CLI still runs pre-refactor code.** Both installed scopes —
  project `.opencode/plugin/mega-skillstate` and user
  `~/.config/opencode/plugins/mega-skillstate` — are Oct-9 snapshots of the
  *flat* `src/` (12 files, no `core/` or `adapters/`, old `server.ts` →
  `./src/index.ts`). Nothing is broken (old code, byte-identical behaviour),
  but Phase 1 is not live. To put it live: `npm run plugin:install` and
  `npm run plugin:install:project`, then restart OpenCode, then spot-check
  the `mega_state` message id and `/skillstate`. The host serves whichever
  copy it loaded — a restart is what swaps it.
- **Push.** `9a9b0d6` (design doc) and `17d2c52` (the fix) — both unpushed.
- **Phase 2 implementation**, once the three unverified shapes above are read.
- Compaction end-to-end is still unproven live (the smoke drives a fake host).
- **Map sizing (deferred).** `docs/features/configuration.md` → `## How & why`
  and `docs/features/skill-state-controls.md` → `## How & why` exceed the ~2 KB
  single-read guidance; `feature_map_regen` can split them.
- Not implemented from `HOST-API-NOTES.md`: `ctx.event.subscribe` idle flush,
  `ctx.session.synthetic` durable turn, `Message.system()` injection role.
- Optional: a token/percentage-gated collapse trigger alongside `min`.

## Known gaps (volatile; the durable traps live in the feature pages)

- **This shell is Windows PowerShell 5.1.** No `&&` (a parser error) — chain
  with `;` and check `$LASTEXITCODE`, or run separate commands. `rm -rf` is
  not a thing: `Remove-Item -Recurse -Force`. A PowerShell here-string gets its
  terminator mangled by the shell tool — commit messages go through the
  scratch file `%LOCALAPPDATA%\Temp\opencode\mega-skillstate-commit-msg.txt`.
- `fixtures/golden.json`'s recorded key is **`transcript`** and it must hold
  the *raw* input: a capture that records the mutated event copy re-records
  the collapsed output as its own input. `scripts/capture-golden.mjs` keeps
  two copies per case — `input` (recorded) and a clone the hook mutates.
  Re-capture only after agreeing a *deliberate* behaviour change.
- Native (provider-side) compaction bypasses the compaction hook's message
  edits; the plugin's `event.result` still applies because `event.messages`
  is never edited.
- A record captures the storage handle at creation, so one process has one
  store. The plugin id namespaces the KV store, so a session written under a
  previous id resumes with an empty Σ (the old record is still there).
- The feature-map index once carried duplicate rows; the check is to `git grep`
  a feature name over `docs/features/README.md` — two hits means it is back.

## Local-only state (not on the remote)

- The remote exists: `github.com/megablue/mega-skillstate`, `main`, with a CI
  workflow (`typecheck` + `smoke` on ubuntu and windows, node 22) and a
  `FUNDING.yml`. Everything except `9a9b0d6` and `17d2c52` is pushed and the
  last push ran green on both runners.
- `~/.config/opencode/mega-skillstate.json` — the live user config; one entry
  beyond the defaults (`feature_map` in `trackTools`). A delete just gets it
  rewritten on the next load; the smoke redirects `MEGA_SKILLSTATE_CONFIG`
  so it never touches a real home.
- The reference plugin
  (`~/.config/opencode/plugins/opencode-feature-map-as-context`) is outside
  this repo and has never been modified.
- `temp/` is ignored: it holds `probe-json-schema.mjs` and the user's
  `invalid_tool_calls.txt` evidence dump. Working artifacts; do not track.
  The folder rename to `mega-skillstate` is long done; the working directory
  is `C:\Users\mega\projects\mega-skillstate`.
- A new session starts with an empty Σ and the plugin re-seeds it as work
  lands. Σ for *this* session is durable in the host's KV store and this
  session's own id, and nothing outside the repo carries it — which is why
  this file is refreshed at handover.
