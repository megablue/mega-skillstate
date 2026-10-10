# Context collapse — turn Σ into the outbound payload

Status: shipped (v0.2) · Read when: outbound payload too big; Σ missing from a request; a tool call and its result were split; idempotence; the `context` hook.

User-visible behavior: `docs/SPEC.md` → Scope. Build-side host API: `HOST-API-NOTES.md`.

## What it does

- Rewrites **only the outgoing request** — never the durable transcript — so the model sees `policy + Σ + recent window` instead of the whole history.
- Injects Σ as one message (`role: user`, id `fmac_state`) placed **after the first user instruction**, so the protected head stays first.
- Collapses the superseded prefix (turns older than `keepRecentTurns`, once past `min`) into Σ; the collapsed span is **durable** (`state/<sessionID>`) and re-applied on every request.
- Seeds `files`/`cwd`/`activeFiles`/`step` from the surviving window, then **renders Σ once** (see the ordering trap).
- Appends a stale-nudge only at a **balanced tail** (`inFlight === 0`).

## Map

- `src/context.ts` — `runContextTransform` (async), `applyTransform` (async), `describeContext` (async), `measureContext`, `roughTokens`, `estimateTokens`, `windowOf`, `messageOf`, `SessionContextEventLike`, `ToolWireEntry` (the name arrives here, so no import cycle with `tool.ts`); types `TransformDeps` (now carries `storage`), the pass report.
- `src/view.ts` — ported safe-cut helpers: `viewOf`, `turnMap`, `turnsOf`, `balanceCuts`, `selectPrunableRange`, `firstSelectableIndex`; injected-id helpers `INJECTED_ID_PREFIX` (`fmac_`), `isInjectedMessage`, `STATE_MESSAGE_ID`, `valueText`.
- `src/prompts.ts` — `SECTION_TEXT` (standing policy), `nudgeText`, `stateMessageText`.
- `src/index.ts` — registers the hook inside `try/catch`; wires `windows` (model windows), the bounded `lastRequest` map, and `ctx.storage` into the transform's deps.

## How & why

- **Strip, then re-apply.** The host hands the raw transcript whole on every request, so
  the pass deletes every injected `fmac_` message first and re-derives the payload from
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

## Related

- `skill-state.md` — the Σ schema, store and `⊕` merge being injected.
- `skill-state-controls.md` — the `skill_state` tool and `/skillstate`.
- `configuration.md` — where the values for the keys above come from.
