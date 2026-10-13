# Session handoff — mega-skillstate

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of `2026-10-14`, the tip is `51adc29` ("Correct the ports by Pi's evidence;
fix the gaps Pi exposed") — `git rev-parse HEAD` for the sha; this file does
not name itself, because amending the fill-in would rewrite it again.
`main` is **ahead of `origin/main` by 8**: `9a9b0d6` (Phase 2 design),
`17d2c52` (the options-path fix), `6ba8823` (a HANDOFF refresh),
`fab51f0`, `f56216b`, `1d34a5a`, `2744efc` and `51adc29` are all local-only.
Phase 1 (`9a2be0a`) **is** pushed — the remote sits before `9a9b0d6`.

## State

- **Phase 1 (the core extraction) is complete and pushed.**
  `9a2be0a` split the host-free core from the OpenCode glue: `src/core/`
  (`config`, `compaction`, `prompts`, `schema`, `seed`, `state`, `types`,
  `view`, plus `ports.ts` declaring the six ports) and
  `src/adapters/opencode/` (`index`, `context`, `tool`, `command`, `types`,
  `config`). `server.ts` re-exports `./src/adapters/opencode/index.ts`. The
  smoke loads `server.ts` exactly as the host resolves it, so the CI loading
  path is what smoke exercises. Behaviour is unchanged and *proven* unchanged:
  `fixtures/golden.json` (captured pre-move, 8 cases) replays byte-for-byte —
  collapse-default still 61 → 14 messages, 15406 → 3642 tokens.
- **Phase 2 (the Pi adapter) is COMPLETE and gated green**, in five commits
  rather than the one the roadmap implied, because each step was pinned before
  the next was written:
  - `fab51f0` — the glue split. `src/core/context.ts` took everything
    host-free out of `adapters/opencode/context.ts` (`applyTransform`,
    `describeContext`, `measureContext`, `windowOf`, the report types); the
    adapter keeps only `runContextTransform` and its three host-coupled lines
    (the SECTION_TEXT push, the tool wire-offer, the sessionID read).
    `core/skill-state.ts` took the write semantics out of `tool.ts`;
    `core/skill-state-command.ts` took the pure half out of `command.ts`. On
    Pi the wire-offer disappears entirely — `registerTool` declares the tool
    on activation.
  - `f56216b` — the adapter, 6 files, 905 insertions. `src/adapters/pi/`:
    `types.ts` (the hand-written host mirror, `export * from
    "../../core/types.ts"` then host-only shapes), `storage.ts` (`appendEntry`
    + `restoreFromBranch`), `context.ts`, `tool.ts`, `command.ts`, `index.ts`.
  - `1d34a5a` — the package manifest. `package.json` gained a `pi` key
    (`{extensions: ["./src/adapters/pi/index.ts"]}`), the `pi-package`
    keyword, and `peerDependencies` for the five host-provided packages at
    `*` — **not** `dependencies` (packages.md warns of duplicate
    classes/registries). A local-path install loads from the resolved path
    without copying, so this repo is itself the Pi package.
  - `2744efc` — **the Pi adapter pinned in the smoke gate.** `scripts/pi-host.mjs`
    is a fake `ExtensionAPI` recording `on`/`registerTool`/`registerCommand`/
    `appendEntry`, with a `getBranch()` answering from the append log;
    `capture-golden.mjs` gained `--host pi` and writes
    `fixtures/golden-pi.json` — a **separate** file, because Pi's payload is
    not byte-comparable to OpenCode's (Pi's context event carries no system
    array, so its tokens are message-only). The four pi groups are
    registration, collapse (14 msg/3384, pairs intact), durable write and
    reply channel.
  - `51adc29` — `ports.ts` corrected by Pi's evidence: both bridges widened
    to `Promise<Disposable | undefined> | undefined` (Pi's `registerTool`/
    `registerCommand` return void; a Pi factory is handed no disposer),
    `CollapseStrategy` gained the `collapse` operation member, and the header
    records the default-export entry shape the ROADMAP had wrong.
  Gate at tip: `npm run typecheck` exit 0, `npm run smoke` exit 0
  (`smoke: ok`), all 8 OpenCode golden cases byte-identical, all four pi
  groups passing.
- **Three shapes the ROADMAP called unverified are now measured** from the
  installed pi package, not assumed: (a) `ctx.ui.notify` is the
  `/skillstate` reply channel, guarded on `ctx.mode`/`ctx.hasUI` because a
  notify on a surface with no UI is a write to a channel nobody reads;
  (b) `ToolDefinition.execute` takes **five** arguments (`toolCallId`,
  `params`, `signal`, `onUpdate`, `ctx`) — not OpenCode's `(input, context)`;
  (c) the manifest is a `pi` key with `peerDependencies`, never
  `dependencies`. The entry point is a **default** export taking
  `ExtensionAPI` — **not** a named `activate` (extensions.md line 22). The
  ROADMAP's Phase-2 line still says `export const activate`; that is the one
  place this was corrected in `ports.ts`'s header but not in the ROADMAP.
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

- **The headline follow-up: the `golden-pi.json` replay is not in the gate.**
  `fixtures/golden-pi.json` exists and is pinned by
  `capture-golden.mjs --host pi`, but `smoke.mjs` does not replay it — the
  byte-level baseline replay was never written. The four pi assertion groups
  cover the same behaviour directly, so the adapter *is* genuinely pinned and
  the gate is green for a real reason rather than by absence. What is missing
  is only the replay. Add it mirroring the `golden.json` block: assert
  `schema === 1`, then per case create a host with `createPiHost()` +
  `loadPiFactory(load)`, drive `made.events['context'][0]`
  `case.passes` times with `piContextEvent(caseTranscriptCopy, case.sessionID)`,
  and assert `checkPairing` plus byte-identical `messages`/`report` via
  `asJson`. **Two deviations that cost an afternoon of guessing:** (1) the
  `no-session-id` case's report is the *guard's* payload-shaped
  `{kind:'no-session-guard', messages}` — assert `asJson` equality against it
  directly, **not** through `cutReport`; (2) for the `command-now` case the
  reply channel is `ctx.ui.notify`, so drive
  `made.commands[0].definition.handler(case.prompt, made.makeCtx())` and
  compare the notify message, not `host.prompts`. Rows are named
  `pi golden: <name>`, plus a `pi golden payloads` summary row.
- **Push.** All 8 commits above. The last push ran green on both runners, so
  nothing about `9a2be0a` is in question, but everything since it is foreign.
- **The CLI still runs pre-refactor code.** Both installed scopes —
  project `.opencode/plugin/mega-skillstate` and user
  `~/.config/opencode/plugins/mega-skillstate` — are Oct-9 snapshots of the
  *flat* `src/` (12 files, no `core/` or `adapters/`, old `server.ts` →
  `./src/index.ts`). Nothing is broken (old code, byte-identical behaviour),
  but Phase 1 is not live. To put it live: `npm run plugin:install` and
  `npm run plugin:install:project`, then restart OpenCode, then spot-check
  the `mega_state` message id and `/skillstate`. The host serves whichever
  copy it loaded — a restart is what swaps it. `npm run plugin:status` reports
  what is installed; `npm run plugin:uninstall` removes it
  (`scripts/install.ts` is the one script behind all four).
- The **Pi adapter has never been driven by a real Pi host.** Its gate is a
  fake `ExtensionAPI` built from installed `.d.ts` shapes, which is honest
  about registration and storage and says nothing about whether Pi restores
  prompt and tool state exactly as the handler assumes. Treat the first live
  run as a real test, not a formality.
- Compaction end-to-end is still unproven live (the smoke drives a fake host).
- **Map sizing (deferred).** `docs/features/configuration.md` → `## How & why`
  and `docs/features/skill-state-controls.md` → `## How & why` exceed the ~2 KB
  single-read guidance; `feature_map_regen` can split them. The two pages
  whose Map entries were rewritten in `fab51f0` were only partially read —
  the exact Map lines were edited by grep, not a full re-read.
- Not implemented from `HOST-API-NOTES.md`: `ctx.event.subscribe` idle flush,
  `ctx.session.synthetic` durable turn, `Message.system()` injection role.
- Optional: a token/percentage-gated collapse trigger alongside `min`.

## Known gaps (volatile; the durable traps live in the feature pages)

- **Two real defects the Pi path exposed, both now fixed — and the lesson in
  neither.** (1) `onRequest` was *declared* in `PiContextOptions`, *passed* by
  `index.ts`, and **never called** by the context handler. Pi's command
  answers through `ctx.ui.notify`, which is not part of a request, so the pass
  has to record what it measured for the command to read later; with the hook
  dead, the payload map stayed empty and every `/skillstate` answered "no
  request has been seen for this session yet", on both arguments. It was
  caught by the smoke, not by reading. (2) The smoke called Pi's **async**
  command handler without `await`, so `made.notifications.length` was read
  before any microtask ran — the assertions measured a pending promise and
  passed for the wrong reason. Both are pinned by the same green run now. The
  general rule worth keeping: **a hook that is declared and passed but never
  called is invisible**, and an unawaited-async assertion is a green row that
  means nothing.
- **This shell is Windows PowerShell 5.1.** No `&&` (a parser error) — chain
  with `;` and check `$LASTEXITCODE`, or run separate commands. `rm -rf` is
  not a thing: `Remove-Item -Recurse -Force`. A PowerShell here-string gets its
  terminator mangled by the shell tool — commit messages go through the
  scratch file `%LOCALAPPDATA%\Temp\opencode\mega-skillstate-commit-msg.txt`.
  **`Get-Content` mangles UTF-8 markdown** — em-dashes read back as `�?"`
  because it decodes as the ANSI code page. Verify a written `.md` with
  `node -e "const b=require('fs').readFileSync('F');const s=b.toString('utf8');console.log(
  b.length, (s.match(/\u2014/g)||[]).length, (s.match(/\uFFFD/g)||[]).length)"` —
  a non-zero replacement-character count is real corruption; the mojibake above
  it in a PowerShell read is not.
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
- **A `?? <default>` on a session id silently voids the case it is meant to
  test.** `piContextEvent` once defaulted its `sessionId` to `"ses_pi"`, which
  handed the `no-session-id` case a real session and made it record a
  collapsed prefix instead of the guard's untouched 61-message payload. The
  default is gone; every call site now passes the id explicitly. Check any new
  harness for the same shape.

## Local-only state (not on the remote)

- The remote exists: `github.com/megablue/mega-skillstate`, `main`, with a CI
  workflow (`typecheck` + `smoke` on ubuntu and windows, node 22) and a
  `FUNDING.yml`. The last push ran green on both runners; the 8 commits listed
  at the top are not on it.
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
