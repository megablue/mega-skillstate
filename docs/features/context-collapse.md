# Context collapse — turn Σ into the outbound payload

Status: shipped (v0.2) · Read when: outbound payload too big; Σ missing from a request; a tool call and its result were split; idempotence; the `context` hook.

User-visible behavior: `docs/SPEC.md` → Scope. Build-side host API: `HOST-API-NOTES.md`.

## What it does

- Rewrites **only the outgoing request** — never the durable transcript — so the model sees `policy + Σ + recent window` instead of the whole history.
- Injects Σ as one message (`role: user`, id `mega_state`) placed **after the first user instruction**, so the protected head stays first.
- Collapses the superseded prefix (turns older than `keepRecentTurns`, once past `min`) into Σ; the collapsed span is **durable** (`state/<sessionID>`) and re-applied on every request.
- Seeds `files`/`cwd`/`activeFiles`/`step` from the surviving window, then **renders Σ once** (see the ordering trap).
- Appends a stale-nudge only at a **balanced tail** (`inFlight === 0`).

## Map

- `src/core/context.ts` — the host-free half of the transform: `applyTransform` (async), `describeContext` (async), `measureContext`, `roughTokens`, `messageChars`, `estimateTokens`, `windowOf`, `stripInjected`, `safeBalance`, `lastUserId`; the Σ message and seed renderers (`stateMessage`, `seedPatch`); types `TransformDeps` (now carries `storage`), `TransformInput`, `ContextReport`, `ContextDescriptor`. It names no host: it takes plain values in and returns plain values out.
- `src/adapters/opencode/context.ts` — the three host-coupled lines only: `runContextTransform` (async), `SessionContextEventLike`, `ToolWireEntry`. It pushes `SECTION_TEXT` into `event.system` (deduped by exact text, so a provider prefix cache stays warm), writes the tool's wire-offer into `event.tools` (the registry is not the request, and a tool only reachable through `tool.transform` is a tool the model can never call), reads `sessionID`, and leaves a payload with none alone. It re-exports the core names above, so they still resolve from here.
- `src/core/view.ts` — ported safe-cut helpers: `viewOf`, `turnMap`, `turnsOf`, `balanceCuts`, `selectPrunableRange`, `firstSelectableIndex`; injected-id helpers `INJECTED_ID_PREFIX` (`mega_`), `isInjectedMessage`, `STATE_MESSAGE_ID`, `valueText`.
- `src/core/prompts.ts` — `SECTION_TEXT` (standing policy), `nudgeText`, `stateMessageText`.
- `src/adapters/opencode/index.ts` — registers the hook inside `try/catch`; wires `windows` (model windows), the bounded `lastRequest` map, and `ctx.storage` into the transform's deps.
- `src/core/types.ts` — the message vocabulary the transform reads, plus `messageOf`.

## How & why

- **Strip, then re-apply.** The host hands the raw transcript whole on every request, so
  the pass deletes every injected `mega_` message first and re-derives the payload from
  `(raw transcript, Σ)`. This is what makes it a pure function and idempotent by design.
- **A cut lands only on a safe boundary.** Collapse uses `selectPrunableRange`, which walks
  back to a boundary `balanceCuts` proves safe; if the payload cannot be balanced the range
  is `null` and nothing is cut. A `tool-call` is therefore never separated from its result.
  A nudge is appended only when the tail has no open call.
- **Ordering trap (load-bearing).** Σ is seeded from **exactly the window that will survive**
  and rendered **once, at injection**. Seeding after the splice would make pass 2 render a
  different Σ and "idempotent" would quietly mean "the last two passes agreed". Seed first,
  render once.
- **Re-apply path.** Once a span is committed, later passes find no fresh range but re-insert
  the remembered Σ at `firstSelectableIndex` with nothing removed — so a session stays bounded
  even when no new turns are prunable.
- **Reads are async, the merge is not.** `describeContext` awaits the store, and a cache miss
  costs one `storage.get`; everything the pass does with Σ afterwards is synchronous.
- **Renderer can't leave a half-written payload:** the rendered Σ text is computed as the
  argument to `splice`, so if it threw, the array is never touched and the host's raw request
  survives. The hook's `try/catch` is the same principle at the boundary — a failed pass logs
  and the uncollapsed request continues.
- Traps: `min` is **turn count**, not tokens; injection is `role: user` (host-proven), the
  semantic alternative is `Message.system` (see host notes, "Open design decisions");
  the wire tool offer carries the tool's **name** (`ToolWireEntry`), because `tool.transform`
  registers a tool but only `event.tools` offers it.

## Config keys / UI

| Key | Default | Meaning |
| --- | --- | --- |
| `min` | `4` | turns before the prefix is collapsed into Σ |
| `keepRecentTurns` | `4` | newest turns always kept verbatim |
| `collapseOlder` | `true` | `false` disables collapsing (Σ not injected) |
| `protectFirstUserMessage` | `true` | never collapse the first user instruction |
| `allowSubagentSessions` | `false` | manage sub-agent (child) sessions |
| `nudgeWhenStale` / `staleAfter` | `true` / `8` | steps with no new user message before a nudge |
| `debug` | `false` | log the pass to stderr |

## Tests that pin it

`scripts/smoke.mjs` (`npm run smoke`) — collapse numbers (61→14), Σ at `messages[1]`,
pairs intact after every phase, **idempotence (two passes, byte-identical)**, `collapseOlder:false`
and subagent guards, stale reminder only at a balanced tail.

**`pairing balance fuzz`** — the pairing invariant over 400 seeded transcripts nobody
wrote by hand: several calls in one message, two results in one message, a call and its
result in the *same* message, and turns with no tools at all. Per transcript, at **every**
index, the assertion runs in both directions — where `balanceCuts` says a cut is safe the
prefix must have no call still waiting, and where it says unsafe that prefix must have one.
The second direction is what keeps the first from passing vacuously: a fold that answered
`true` everywhere would fail it. Then `selectPrunableRange` runs on each and the kept
window is re-checked with `checkPairing`. Seeded, so a failing seed reproduces. This is the
roadmap's *pairing-balance fuzz (no split pairs across many simulated requests)* — and it
needs no live host, because a simulated request is exactly what the smoke already builds.

**Byte-level baselines** — the same story as a fixture, so a reshape of the payload passes
only if it passes every case. `fixtures/golden.json` (8 cases) replays byte-for-byte through
the OpenCode host: those 8 cases must stay identical across *every* core change, which is
what makes host-neutrality a measurement rather than a design claim. `fixtures/golden-pi.json`
(7 cases) replays through `scripts/pi-host.mjs`'s fake host, because Pi's context event
carries no `system` array and its token counts are message-only — Pi's numbers are its own
baseline, not a copy of OpenCode's. Re-capture with `scripts/capture-golden.mjs` (`--host pi`
for the second file), always out to a scratch dir, and only replace a fixture after the diff
says exactly the cases you meant to change. One derivation to keep straight: the no-session
case's `expect.report` is `{kind:'no-session-guard', messages}` — a summary of the payload the
guard hands back, not the report shape — so the replay branches on `!Array.isArray(report?.notes)`
and asserts the two halves agree on the shape before comparing bytes.

## Related

- `skill-state.md` — the Σ schema, store and `⊕` merge being injected.
- `skill-state-controls.md` — the `skill_state` tool and `/skillstate`.
- `configuration.md` — where the values for the keys above come from.
