# Session handoff — mega-skillstate

Next: `docs/features/README.md` — the feature map. Read only the page for
your area before the code.

**A snapshot, not a source of truth.** This file goes stale by design. If it
disagrees with the code, the code is right. `AGENTS.md` is the process doc,
`docs/features/` is the feature map and `docs/SPEC.md` is the behaviour spec.
This file is the volatile one — it exists so a new session knows *where things
stand*, not *how they work*.

As of the model-side recall commit, the tip is `d38a8d4` ("Let the model read
back what the Sigma fold set aside") - `git rev-parse HEAD` for the sha;
this file does not name itself, because amending the fill-in would rewrite it
again. `main` is **ahead of `origin/main` by 1** (`d38a8d4` is local, not pushed) -
measured by `git rev-list --count origin/main..HEAD` after that commit landed,
which is the check that never goes stale, because this header cannot re-count
itself. Everything through `c63da54` is on the remote and the CI run for that
pushed tip (`38613861197`) went green on both runners. **Push is the user's
call: every commit since `c63da54` is local, so it is unverified on CI rather
than green.** State it that way rather than paraphrasing an older green run.

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

- **Payload erosion (levers A, C, D shipped; B research-only) — `beeb72f`.**
  `src/core/erosion.ts` (new) plus step 7 of `applyTransform`, after the collapse
  and the seed and before the nudge, so it works on the final payload while the
  seed and the fold arithmetic still read the raw conversation. Two cuts, both
  content-only and both idempotent by construction: **fold** an old turn's
  `skill_state` patch body into a marker (`foldPatchInputs`, default on), and
  **cap** an old turn's oversized result to head + omission marker + tail
  (`maxResultChars`, 4000, `0` disables; `glob` exempt, because the seed reads
  one). The **Σ size line** is the third lever (`sigmaWarnTokens`, 16000, `0`
  disables); the same threshold now also gates the Σ fold added in `424b719`, so
  the line and the fold always agree about how big is too big — though the fold can
  remove what the line complains about, in which case the next report is silent.
  Everything is pinned in the smoke (`erosion`, `erosion idempotence`, `erosion
  config`, `sigma warning`), and the 8 + 9 golden cases stayed byte-identical,
  which is the proof the change was behaviour-neutral where nothing needed
  changing.
- **What this actually was, and the correction it carries.** The live case that
  opened the section was `417369 -> 458371` tokens on a pass that folded nothing
  (`msf-6k9`). The synthetic probe had priced the erosion as 99-99.9% tool-result
  value; **measuring the real sessions said otherwise** — the kept window is the
  model's own patch bodies (38-52%) and reasoning (25-84%), not tool results
  (10-22%). The table in ROADMAP §10 records the four sessions. Read it before
  assuming a probe described this workload.
- **B (reasoning pruning) is research-only, and it is the biggest lever left.**
  A reasoning part cannot be truncated without severing a provider signature, and
  dropping one wholesale is a different decision again — whether the host
  forwards the field at all, and in what shape. Nothing here is measured: it
  needs a provider answer first.
- **Σ condensation (`docs/OPTIMIZATIONS.md` F6) is CLOSED — shipped in `424b719`.**
  Σ is findings-dominated in every real session (86.5% PLO1, 79.5% phase2), and
  `src/core/sigma-condense.ts` now folds it inside `writeSkillState`: gated on
  `sigmaWarnTokens` (the same line the report complains about, so `0` disables
  both) with `sigmaCondenseChars` (400, `0` disables) as the floor. Two folds, both
  decided by a key and never by reading the prose — a finding whose key is another
  key plus a correction suffix (`_corrected`, `_again`, a closed list) replaces the
  key it corrects, and a numbered series of three or more (`probe_step3`) keeps only
  its newest member; a finding over the floor keeps its head and its tail. What
  leaves the render goes to the record's **archive**: cold (`render` never emits
  it), bounded oldest-first with the newest entry never the one dropped
  (`MAX_ARCHIVE_CHARS` 262144). It reads back two ways. By the user:
  `/skillstate <key>`, which prints one entry in full, and `/skillstate archive`,
  which lists what was set aside; both answer without a payload, because the
  archive is durable. By the model: `skill_state` with a `recall` property
  (`d38a8d4`) — a key prints it in full, `recall` as the word `archive` lists the
  archive, a recall performs no write, advances no step and persists nothing, and
  the reserved word is decided by the same function (`recallAsk`) the command
  parses with, so the two routes share one wording. The dispatch lives in
  `runSkillState` in the core rather than in either adapter (Pi hands the
  parameters over as the second of five arguments, OpenCode as the first of two). The floor, not the
  mechanism, is the decision, and it was measured from the store first: 400 removes
  17.6K / 13.3K
  / 7.5K tokens on the three live sessions, 800 only 3.9K / 4.5K / 5.5K. Key
  supersession on its own is about 3K characters — hygiene, because the merge
  already replaces a same-key value — so the length fold is the lever.
- **Three defects the condensation gate found, all fixed in `424b719`.** (1) The
  fold's marker arithmetic reserved its width by measuring a *built placeholder*,
  and a concatenated number contributes its digits rather than its digit count: a
  folded finding came out 404 characters against a 400 floor, so the fold was not
  idempotent. (2) The archive's original bound (65536) made its eviction drain
  itself to empty on a 90000-character fold, so the write persisted
  `archive: undefined` and destroyed exactly the text the archive exists to keep —
  the bound has to be generous *relative to the size gate*, because one fold pass
  can set aside tens of thousands of characters. (3) **Pre-existing and shipped
  since the erosion commit:** `cappedResultText` returned the head's *count*
  instead of the head, so every capped tool result began with a number where the
  text it kept should have been; the smoke's `<= 4000` assertion passed because a
  four-character number is a very short string. Capped payload bytes changed here —
  if a result's exact bytes matter, re-measure rather than recall.

- **The archive read path — `0e0e298`**, and the answer to "the fold took it, now
  what". `/skillstate <key>` prints one finding in full out of the session archive;
  `/skillstate archive` lists what was set aside, largest first, marking the keys Σ
  no longer holds. `parseAsk` splits the argument into the four asks in
  `core/skill-state-command.ts` so both hosts share the words; `recordFor` reaches a
  record from `deps` rather than from a live payload, which is why a recall answers
  in a session no request has reached; the size line now names the archive and the
  command once a fold has run, so a model told to consolidate can see the way back.
  Pinned by the `skillstate archive` and `skillstate recall` rows — the decisive
  assertion is that the reply contains the *middle* of the folded value while the
  render does not (a literal marker, not a filler window, because the filler repeats
  by period). **The model-callable read was built after all, at `d38a8d4`.** The
  two reasons it was called out of scope (`TOOL_INPUT` would change and the
  `required: ["state_patch"]` host gate would refuse a recall-only call) both
  measured wrong: `TOOL_INPUT` has no `required` array at all, so a recall-only
  call passes the host's pre-`execute` validation untouched and the either-or rule
  is enforced inside `execute` instead. What it *did* cost was the state-message
  footer and the tool description, whose bytes the golden fixtures pin — both
  fixtures were re-captured, and the diff was exactly the new footer sentence plus
  its token cost. **A scope call for the user is a hypothesis until it is measured.**

- **Closed — the `golden-pi.json` replay is in the gate.** `93eb25c` added
  it: `smoke.mjs` replays `fixtures/golden-pi.json` (7 cases) byte-for-byte
  the way it replays `golden.json` (8 cases), and the gate prints
  `pi golden payloads: 7 case(s) replayed byte-for-byte` plus the OpenCode
  `8 case(s)`. `3108592` then named both baselines in
  `docs/features/context-collapse.md` → `## Tests that pin it`. **Two traps
  cost an afternoon here and are worth keeping:** (1) the capture drove the
  context pass under one session id and asked the command about
  `makeCtx`'s default id, so `capturePiCommand` recorded a *correct answer
  to the wrong question* — the fixture pinned the pre-fix
  "No request has been seen" reply and the re-capture came back
  byte-identical until the capture passed
  `made.makeCtx({ sessionId: spec.sessionID })`; re-capture only after the
  re-capture *differs*, or you are just re-recording the bug; (2) the
  no-session case's recorded report is a **summary** shape
  (`{kind:'no-session-guard', messages}`) derived from the guard's
  payload-shaped return, not that return value — branch on
  `!Array.isArray(report?.notes)` and derive the summary exactly as
  `capture-golden.mjs` does (lines 510, 527-528), then compare; running it
  through `cutReport` throws, and comparing the raw return never matches.
  Rows are named `pi golden: <name>`, plus the `pi golden payloads` row.
- **Push — one commit owed, and it moved twice.** Everything through `c63da54` is
  pushed and its run (`38613861197`) is green on both runners; `424b719` and
  `c63da54` went up together, and the local one is now `d38a8d4` (the model-side
  recall), measured `origin/main..HEAD` = 1 at handover. The run
  for the first push of the Phase 2 batch (`38387263678`) was red at `npm ci` —
  the lock file lagged the `1d34a5a` peerDependencies — and `7f23890` fixed it,
  with run `38388970742` green on both runners. Two traps from that history are
  worth keeping: a run is *named* after its tip commit but is not necessarily
  *caused* by it (read which step failed before theorising about the cause), and a
  `peerDependencies` change must regenerate the lock in the same commit.
- **The CLI runs the refactored code (measured 2026-10-14 18:30).** Both
  installed scopes — project `.opencode/plugin/mega-skillstate` and user
  `~/.config/opencode/plugins/mega-skillstate` — hold the *refactored* tree
  (`server.ts` → `src/adapters/opencode/index.ts`). This bullet previously
  claimed the opposite (Oct-9 flat-`src/` snapshots, Phase 1 not live) and that
  claim was **wrong**; it was true once, and was never re-measured before
  being repeated. What the measurement actually showed: 29 of 31 `src/` files
  byte-identical to the repo, the forced-report fix already inside the
  installed `skill-state-command.ts`, and the host restarted 9 seconds after
  the last install (12:13:28 → 12:13:37). **Measure before asserting; a stale
  handoff line is still wrong when it is confidently repeated.** Both scopes
  were then refreshed anyway (`plugin:install` + `plugin:install:project`,
  39 files each, `plugin:status` now "in sync" for both) because that is free
  and removes the question. The two files an earlier `src/`-only check missed
  as absent were `src/proxy/config.ts` and `src/proxy/mcp.ts`; the plugin
  half never imports `src/proxy/` (grep: 2 comment lines in `ports.ts` only),
  so their absence never affected the running host. The remaining live-verification
  field work is the **daemon** (Claude Code / Codex pointed at it), which no
  install script can settle. `npm run plugin:status` reports what is
  installed; `npm run plugin:uninstall` removes it (`scripts/install.ts` is
  the one script behind all three).
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

- One commit is local-only: `d38a8d4` ("Let the model read back what the Sigma
  fold set aside"). Everything else is on
  `github.com/megablue/mega-skillstate` (`main`, with a CI workflow running
  `typecheck` + `smoke` on ubuntu and windows, node 22, and a `FUNDING.yml`), and
  the run for the pushed tip (`c63da54`, run `38613861197`) is green on both
  runners. The one red run (`38387263678`, named
  after a docs-only commit but actually the `npm ci` EUSAGE on the lock file) was
  fixed by `7f23890` and is history, not an open thread.
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
