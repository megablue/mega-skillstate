# skill_state — live-session failure modes, optimizations, and fixes

Status: investigation report (read-only; no source changed) · Date: 2026-10-13.
This file is the only artifact added by the investigation. Per the task scope it is
deliberately **not** wired into `docs/features/` — when a fix lands, fold its outcome
into the relevant feature page in the same commit as the change.

## What was asked, answered first

- **"A couple of failed soft skill_state calls."** There are three distinct failure
  classes, not one, and the count is larger than a couple: **29 soft refusals**
  (`state_patch` sent as a malformed JSON string; 27 in PLO1, 2 in refactor) plus a
  **deterministic hard failure** (`summary: undefined` in the tool result) that hit
  this analysis session twice and an unrelated session (`ses_ed02851e…`,
  droid-signal-reset) **three times out of three calls**, plus one host-argument
  rejection and one network drop. See F1–F3 and F8.
- **"An agent thought the objective was mangled."** Confirmed, and the cause is the
  model's own patch composition, not the runtime: in PLO1 the objective at step 392
  was a self-repeating blend of an old and a new line; the model itself flagged it as
  "a slightly garbled objective (repeats itself)" one nudge-review later and rewrote
  it. Two stale/contradictory objectives in the refactor session are the same family.
  No runtime corruption was found (see F4; also the mojibake in early dumps of this
  investigation was a PowerShell console artifact, not stored data).

## Evidence base

- 644 `skill_state` calls extracted from `opencode.db` → `session_message` rows
  (assistant `content[]` tool parts), plus the per-session Σ records in the `kv`
  table (`plugin:…:state/<sessionID>`).
- Sessions: PLO1 `ses_ed9e539efffeZbHsTie92uwpKH` (530 calls), refactor
  `ses_eda7c6272ffewD0FPt4sviRxj5` (114 calls), this session
  `ses_eca71508bffeAAIwcnCDXR8YMz` (live experiments), adb
  `ses_ed02851e7ffepreWnTr0P3Ulgc` (independent corroboration).
- Scratch analysis scripts and dumps live in
  `%LOCALAPPDATA%\Temp\opencode\skillstate-analysis\` (`tool-calls.json`,
  `analysis3..6.txt`, `failed-inputs.txt`, `adb-full.mjs`, …). Nothing in the repo
  was modified except this file.
- The host runs the **installed copy** of the plugin, which currently lags the repo
  (F7). Anchors below name repo sources; the installed copy at
  `…\.config\opencode\plugins\mega-skillstate\` (and the project-scope twin) carries
  the same relevant lines today, so a fix must be reinstalled before it can be
  observed in a live session.

---

## F1 — Deterministic hard failure: `summary: undefined` in the tool result

**Severity: critical. Reproduced live. A write "fails" but has already persisted.**

- **Symptom** (host error, whole call marked failed):
  `Tool returned a non-JSON value for its output schema: Expected JSON value`.
- **Trigger.** The declared output is `TOOL_OUTPUT = { type: "object", … }`
  (`src/core/skill-state.ts`). `writeSkillState` builds
  `output.summary = record.summary()` (repo `src/core/skill-state.ts:222`; same line
  in the pre-extraction installed copy at
  `src/adapters/opencode/tool.ts:192`). `record.summary()` is `string | undefined`
  (`src/core/state.ts`), and it is `undefined` until some write passes a `summary`
  argument — or after a write clears it with `summary: ""`. An `undefined` leaf is
  not JSON, and the host rejects the whole result.
- **Who hit it, and why others escaped.** The trigger is simply: *a write while no
  summary has ever been set.* PLO1's first call (`seq 113`) and the refactor
  session's first call (`seq 122`) both passed `summary` — so both sessions never
  saw this error once. This session's first two calls (`seq 89`, `seq 98`) passed no
  `summary` and both failed; the third call passed `summary: "probe"` and succeeded,
  after which every no-summary write was fine. The adb session made exactly three
  `skill_state` calls in its whole life — all three without a summary, all three
  failed, and none of its intended state was ever accepted. **A fresh session whose
  model omits the optional summary on its first write burns every write until it
  happens to pass one** — the common case, since the summary is described as
  optional.
- **Live reproduction (this session, 2026-10-13).** With a summary present, writes
  succeed. A call that clears it (`summary: ""`) returned exactly
  `Tool returned a non-JSON value for its output schema: Expected JSON value`; the
  very next call, carrying a summary again, succeeded. The store shows the
  failed clear had already taken effect (`summary` gone, step advanced) —
  see "phantom write" below.
- **Phantom write (second bug inside the first).** Validation happens *after*
  `execute` has merged and persisted, so this class reports failure while the write
  has landed. Confirmed twice:
  1. This session's `seq 89` errored, yet the current Σ still contains that patch's
     `files` and `open` values, which were never re-sent;
  2. the clear-test call errored, yet `kv` shows its `summary` clear and step bump
     persisted.
  Consequence: a model that reads the error as "nothing was written" re-sends the
  same patch (wasted call, confusion, occasional duplicate "changed: none" acks) —
  while the record silently moved.
- **Fix (one line, plus a pin).** In `writeSkillState`, either
  `summary: record.summary() ?? null` or omit the `summary` key when `undefined`.
  Add a smoke pin: a write with no summary must produce an output with no
  `undefined` leaf (assert `output.summary` is absent or `null`). Apply the same
  line in the installed copy's `tool.ts` **or** reinstall (`npm run plugin:install`
  and `npm run plugin:install:project`) and restart the host; the host resolves the
  plugin once per process.
- **Open question.** Whether the host's rejection could also be avoided by a
  stricter `TOOL_OUTPUT` — no: the schema is already permissive; the value itself is
  the problem. The `?? null` fix is the minimal correct one.

## F2 — Soft refusals: `state_patch` sent as a malformed JSON string (29 calls)

**Severity: high-frequency friction (4.5% of all calls). No data loss recorded, but
retries cost calls and once shortened a finding.**

- **Symptom** (soft refusal; Σ untouched; call marked *completed*):
  `state_patch arrived as a string that is not valid JSON; nothing was written. Pass
  the object itself, not a quoted or fenced copy.`
- **Taxonomy of all 29 recorded strings** (parse-tested against Node's `JSON.parse`;
  archived in `tool-calls.json`):
  | class | n | shape |
  | --- | --- | --- |
  | extra trailing `}` | **26** | one closing brace too many after an otherwise valid object (`…"}}` for a patch that ends `"}`), incl. strings that double-wrap the whole call as `{"state_patch": {…}}` |
  | unclosed / truncated | 2 | parse ends mid-structure (`Expected ',' or '}' … at position <end>`) |
  | quote-shifted key | 1 | `"execution_policy_note: \"…\"` (seq 7504) |
- **The double-wrap sub-family.** Four string patches parsed as valid JSON whose only
  top-level key was `state_patch` — the merge dropped it and the ack said
  `dropped (not in the schema): state_patch` with `changed: none` (e.g. retry of
  `seq 6573`). Same model confusion as the refusal, one brace away from it.
- **Retry behaviour.** 27 of 29 recovered on the very next `skill_state` call —
  but the cost is real: one cluster (`seq 7970/7977/7992`) failed three times, and
  the eventual success for that content (`seq 7999`) carried only the step; the
  model then re-wrote the finding **shortened** (`seq 8008`). Detail degradation
  after a refusal is the concrete loss channel.
- **What the models understood.** Most modelled the refusal as a size or quoting
  problem and retried "smaller" — e.g. seq 2792: "maybe because of the colon inside
  the string…"; seq 5685: "maybe the harness serialized it wrong, or my JSON had a
  problem." The message names the payload but not the defect, so the retry is a coin
  flip. The refactor session's later reasoning shows the learning stuck ("the
  state_patch must be an object… I'll pass the object"), and the retry succeeded.
- **Fixes, ranked:**
  1. **Enrich the refusal** (cheap, certain): include the parse error and character
     position, plus a short tail of what arrived — e.g. *"parse failed at char 146:
     unexpected '}' after the end of the value; the string ends `…"arm"}}` — you
     likely added one closing brace too many."* Models fix precise errors; they
     cannot fix a diagnosis-free refusal. `parsePatch`'s `catch` in
     `src/core/skill-state.ts` is the one place to change.
  2. **Tolerant repair for the dominant class** (the 26): when `JSON.parse` fails,
     try a single retry after stripping redundant trailing `}` characters (only
     when the remainder parses to a plain object **and** nothing else was dropped);
     accept and say so in the ack (`note: repaired — one trailing "}" removed`), so
     the correction is visible and teaches the model, exactly like the existing
     `fromString` note. Validate against all 29 archived strings; anything that
     would lose content still refuses. Do not attempt repair for the truncated
     class — that is where silent content loss would hide.
  3. **Tool-description tweak**: reinforce "pass the object itself"; if a string is
     unavoidable, "it must be the exact object JSON — no extra closing brace, no
     wrapper". (`toolDescription()` in `src/core/prompts.ts`.)
- **Already good:** the refusal never touches Σ (parse precedes the store), and the
  union-typed `state_patch` input is what keeps these calls inside the plugin rather
  than at the host gate — keep both.

## F3 — Host argument-gate rejection: `step` fused with the payload (1 call)

**Severity: medium (rare, but the whole call is lost before the plugin runs).**

- Refactor `seq 3266`: the model emitted `step` as a string that had swallowed the
  rest of the JSON — host error:
  `Invalid arguments for tool "skill_state": - step: Expected number` (arguments
  showed `"106,\n\"state_patch\": {…}`). Because the host validates before `execute`,
  the plugin never sees the call and **nothing is written** (no phantom write here).
  The model re-sent it correctly on the next call, and its own note ("arrived as a
  mangled string, so nothing was written") matched the truth for this class.
- **Fix option:** widen `step` to `{ type: ["integer", "string"] }` (the same union
  trick `state_patch` already uses to cross the host gate) and in `writeSkillState`
  accept a pure-integer string; if the string contains `"state_patch"`, return a
  precise soft refusal (*"step must be its own integer argument; your patch appears
  fused into `step`"*) or, optionally, recover the fused patch when it parses.
  Low priority relative to F1/F2, but cheap.

## F4 — Objective quality: model-authored garble and stale objectives

**Severity: medium (record hygiene; a garbled objective misleads every later
request until someone fixes it). No runtime corruption was found.**

- **The garble (PLO1).** `seq 9452` wrote:
  `"tray lib.rs: ShellExecuteW open helper DONE; next TrayAction::CheckUpdate (…);
  ShellExecuteW open helper; read 60-110 shows TrayAction 66-73, …"` — a blend of
  the new sentence and the tail of the previous objective (the phrase repeats; the
  line numbers are stale). One nudge-review later the model read Σ back, judged it
  "slightly garbled (repeats itself)", and rewrote it clean (`seq 9461`, same
  message). The failure mode is patch composition: rewriting a long objective by
  gluing text, with no length or duplication guard anywhere in the loop.
- **Stale/contradictory objectives (refactor).** `seq 1035`: objective still
  "Done — coffee/FUNDING change committed…" when the work had not been committed;
  `seq 3100`: objective said "remaining: update the 5 feature pages… then commit"
  while `done` already carried commit `9a2be0a` — the model noticed the
  contradiction and patched both. A third note (`seq 1163`) is the model reasoning
  about **how much to trust Σ** ("error result → don't believe the nearby `done`") —
  trust heuristics forming by hand where the runtime offers no signal.
- **Optimizations (warn, never reject — the schema owns shape, not content):**
  1. **Objective lint in the ack.** After a write, run a deterministic check on
     `state.objective`: repeated substrings (e.g. any ≥24-char segment occurring
     twice), length ≥ ~200 chars, newline present, or `next/remaining` phrasing
     while every `plan` item is `done`. Append one line to `ackText` output:
     `objective note: repeats a phrase — consider rewriting it as one short line`.
     The ack is the loop the model already reads; this is where it can learn.
  2. **Guidance.** In `toolDescription`/policy, say explicitly: keep `objective` a
     short *current* goal; put detail in `plan`/`findings`; rewrite it, don't append
     to it.
  3. Optional: `nudgeText` asks for a one-line "does `objective` still describe the
     current goal?" review — the PLO1 garble survived until exactly such a review
     happened by accident.

## F5 — Ack semantics are ambiguous

**Severity: low, but it compounds — the ack is the model's feedback loop.**

- **`(changed: none)`** (≥9 in PLO1): indistinguishable between "your values were
  identical to what was already there" (correct no-op), "your write landed but the
  host reported failure" (F1 phantom case, where no ack is ever delivered at all),
  and "you passed the same `step` again, nothing else new". Examples where the
  model then re-patched defensively: `seq 8647`, `8764`, `9058` (step-only writes
  that equalled the current step).
- **Same-step consecutive acks**: 21 of 502 PLO1 ack pairs report the same step
  twice in a row (e.g. `step 286 (changed: step)` then `step 286 (changed: plan,
  findings, open)`), because the model re-passed the current step number. Refactor:
  0 of 111. Reads like a lost increment.
- **Proposal:** ack phrasing that names the situation, e.g.
  `changed: none (values already identical)` and `step 286 (kept; not set this
  write)` vs `step → 287 (set)`. Purely additive text in `ackText`
  (`src/core/prompts.ts`); no schema change.

## F6 — Σ growth: 119 KB state in PLO1

**Severity: medium design risk; needs a decision, not an emergency fix.**

- `kv` sizes: PLO1 **118,979 bytes** at step 485 (524 steps of findings-heavy work);
  refactor 70,775 bytes at step 127; this session ~8 KB. The injection path
  (`stateMessageText` → `render(state)`) carries the whole state on every request,
  so the bounded-context promise erodes exactly on the long sessions it matters for.
- Options: (a) a threshold line in the ack (`Σ is ~30k tokens; consolidate
  findings`); (b) guidance to move resolved items out of `findings`; (c) a
  per-key/per-value cap convention in the schema hints; (d) a deliberate design
  pass on condensation (kept out of scope here). Recommend measuring the injected
  payload at a few sizes before choosing.

## F7 — Operational: the running plugin is an installed copy that lags the repo

- Hash comparison (2026-10-13): `src/adapters/opencode/index.ts` identical in both
  installs and the repo; `src/adapters/opencode/tool.ts` **differs** (installs
  predate commit `fab51f0`, the core extraction; installs have no
  `src/core/skill-state.ts`); user-scope and project-scope installs are byte-identical
  to each other. The host loads the copy, once per process — so **any fix in this
  report must be reinstalled and the host restarted before it can take effect**:
  `npm run plugin:install`, `npm run plugin:install:project`, then
  `npm run plugin:status` to confirm no drift, and restart OpenCode.
- All hash drift is contractual (copy, not link) — the failure mode is that a fix
  looks "live" in the repo while the host still runs yesterday's code.

## F8 — Transport and minor notes

- **ECONNRESET** (PLO1 `seq 3459`): one `skill_state` call died with
  `provider.transport … ECONNRESET`; whether that write persisted is unknowable
  post hoc. No model reaction recorded. Environmental; no plugin action.
- **Schema confusion (dropped keys)**: `state_patch`×4 (the double-wrap above),
  `summary`×2 (models nesting the summary argument inside the patch),
  `reveal_question`, `runtime_page_list`, `tray_menu_code`, `objectives__remaining`
  (typo of `objective`), ×1 each. The ack names all of them — the learning loop
  works; no action needed beyond F2's message work.
- **Nudges did their job**: every PLO1/refactor nudge triggered a currency review
  (this is how the PLO1 garble was caught). The improvement in F4.3 is a sharpening,
  not a repair.

## Suggested order of work

1. **F1** — one-line fix + smoke pin + reinstall/restart. Deterministic, affects
   every fresh session whose first write lacks a summary (two known victims
   already), and the phantom-write half makes the misleading report worse.
2. **F2.1** — enriched refusal message (position + tail). Cheap; directly cuts the
   29-refusal retry loop.
3. **F2.2** — tolerant repair for the extra-brace class, validated against the 29
   archived strings; keep refusals for everything else.
4. **F4.1 + F5** — ack lint line and ack phrasing. Small, additive text changes in
   `ackText`; visible in every write.
5. **F3** — `step` union + precise refusal (or recovery).
6. **F6** — measure then decide (design).

## Validation for whoever implements

- `npm run typecheck` and `npm run smoke` (add the F1 pin; extend the parse tests
  with the archived refusal strings for F2.2). Both installs then reinstalled;
  `npm run plugin:status` clean; host restarted.
- Live check for F1: in a fresh session (or after clearing the summary), a write
  with no `summary` must **succeed**, and `kv` must show the patch landed — and no
  call may ever render `output.summary` as `undefined`.
- The refusal strings to test against are in
  `%LOCALAPPDATA%\Temp\opencode\skillstate-analysis\tool-calls.json` (29 entries
  whose `contentText` starts with "state_patch arrived as a string").
