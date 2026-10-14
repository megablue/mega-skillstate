# mega-skillstate — Roadmap (portability)

**Status:** active, Phase 3 underway. Phases 1 (core extraction, `9a2be0a`) and
2 (Pi adapter, through `51adc29`) are landed and gated green; the proxy's two
codecs are the first Phase 3 slice.
**Decided (2026-10-10, user):** Tier 2 (Claude Code / Codex) goes through a
**wire-level proxy daemon** (full fidelity). Hooks-only degraded mode is a
fallback only, not a route.

> This is a **plan**, not a description of the code: `docs/features/` is the
> mechanism, `docs/SPEC.md` the user-visible behavior, `AGENTS.md` the process.
> Phases here become feature pages as they land.

## 1. Goal

Run the plugin's core on four targets:

| Target | Tier | Mechanism |
|---|---|---|
| OpenCode | 1 — native | existing `context` hook (baseline, adapter #0, no behavior change) |
| Pi (earendil-works/pi) | 1 — native | `context` event (request-local) + `registerTool` + `appendEntry` |
| DeepSeek Harness | 1 — native | durable **surface replacement** (no request seam exists by design) |
| Claude Code + Codex | 2 — proxy | one local daemon: request rewriter + MCP server + shared Σ store |

And establish the rule that **future features are core-only changes**. Adapters
are touched only when a feature needs a capability the port interface does not
expose — interface growth, once per adapter, small and mechanical.

## 2. Why the proxy for Tier 2

- Claude Code hooks cannot rewrite conversation history (`PreCompact` can block
  but cannot inject — issues #46191 / #50682); Codex hooks likewise cannot
  touch the payload. A proxy behind `ANTHROPIC_BASE_URL` /
  `model_providers.<id>.base_url` gets the exact same "rewrite the outbound
  request, never the transcript" seam the in-process adapters use.
- One daemon serves both hosts and also carries `skill_state` over MCP (stdio +
  streamable HTTP) — so the tool works even where only MCP is wired up.
- Codex caveat, documented, not blocking: ChatGPT-subscription auth does not
  route through custom providers; the proxy requires the API-key route. The
  hooks-only degraded mode (Σ injection, no collapse) is the documented
  fallback there.

## 3. Target architecture

```
src/
  core/                  pure, host-free
    schema.ts            Σ schema + ⊕ merge (null-delete, unknown-key drop)
    state.ts             per-session state logic (over the Storage port)
    seed.ts              derived floor from tracked call arguments
    view.ts              turn numbering, safe cuts, call/result pairing balance
    prompts.ts           section / nudge / ack / report text
    context.ts           the host-free transform: applyTransform, describeContext
    skill-state.ts       the write semantics both hosts' tools wrap
    skill-state-command.ts  the pure half of the command's report
    compaction.ts        the compaction seam (duck-typed CompactionEvent)
    config.ts            resolveOptions / resolveConfig / resolveThresholds
    types.ts             minimal core message/part vocabulary
    ports.ts             the six port interfaces
  adapters/
    opencode/            context hook, skill_state tool, command, StorageDomain
    pi/                  context event, registerTool, registerCommand, appendEntry
    dsh/                 surface replacement, ctx.tools.register, command, session events
  proxy/
    server.ts            HTTP reverse proxy, SSE passthrough (never buffers streams)
    codec-anthropic.ts   Messages API ↔ core vocabulary
    codec-openai.ts      Responses API ↔ core vocabulary
    mcp.ts               skill_state MCP server (shares the store)
    store.ts             durable Σ store (SQLite), session identity mapping
    config.ts            port, upstreams, thresholds (mirrors options.json), debug
```

The six ports (keep them coarse — six, not sixty):

1. `CollapseStrategy` — `request-rewrite` (OpenCode, Pi, proxy) or
   `surface-replacement` (DSH)
2. `Codec` — host parts ↔ core vocabulary; strip/restore opaque content
3. `Storage` — durable per-session Σ
4. `ToolBridge` — register a tool with schema + handler
5. `CommandBridge` — register a command + reply channel
6. `SessionLifecycle` — session identity, init, dispose

Rules: no host conditionals in core; the port interface grows only by adding a
method; adapters translate decisions, they do not implement features.

## 4. Phases

### Phase 1 — Core extraction (no behavior change)

- [ ] Move the pure modules (`schema`, `state` logic, `seed`, `view`, `prompts`,
      policy, tool/command semantics) into `src/core/`; define the six ports.
- [ ] OpenCode becomes adapter #0: `index.ts`, `tool.ts`, `command.ts` envelopes
      move under `src/adapters/opencode/`.
- [ ] Capture golden payload fixtures from current behavior (before/after
      transform: collapse + Σ injection) as part of the conformance corpus.
- **Gate:** `npm run typecheck` + `npm run smoke` green; golden payloads
  byte-identical (idempotence, call/result pairing, null-delete unchanged).
- Docs: feature-map update per `AGENTS.md` (mechanism moved, no behavior change).

### Phase 2 — Pi adapter

- [ ] `context` event → `CollapseStrategy: request-rewrite` (exact analogue of
      the OpenCode hook; Pi restores prompt/tool state after the handler).
- [ ] `skill_state` via `registerTool` (TypeBox params; same core semantics).
- [ ] Σ via `appendEntry` + `sessionManager.getBranch()` reconstruction on
      `session_start` — durable, branch-aware, resume-safe (replaces the KV
      blob for Pi; better than OpenCode's store).
- [ ] Standing policy via `before_agent_start` (`systemPromptOptions` sections).
- [ ] `/skillstate` via `registerCommand` + `ui.notify`.
- [ ] Package as a Pi package (jiti loads TS directly, no build step).
- **Gate:** core conformance suite passes on Pi; manual session shows collapse
  + Σ restore across resume.

**Design** (verified against `pi/packages/coding-agent/src/core/extensions/
types.ts`, read in full — 2328 lines, 2026-10-13; nothing below is assumed):

**Entry.** A Pi package is an `ExtensionFactory` — a **default export** taking
the host's `ExtensionAPI` (`export default function (pi: ExtensionAPI)`), sync
or async init, and jiti loads the TypeScript directly — no build step. So the
adapter's entry is a factory, not `setup(ctx)` + a disposable: `registerTool` and
`registerCommand` both return `void` (no registration handle to keep, unlike
OpenCode's `Registration`), and every `on(event, handler)` returns the
unsubscribe `() => void`, which is the only lifetime the factory holds.

**Core reuse, unchanged.** `schema.ts` (⊕ merge, render, key accounting),
`seed.ts`, `view.ts` — Pi's own part vocabulary (text / reasoning / tool-call /
tool-result) *is* the core vocabulary, so `Codec` is identity — `prompts.ts`,
`state.ts` (`StoreDeps.storage` is already the Storage *port*, so the Pi adapter
passes its own implementation and `core/state.ts` is untouched), `compaction.ts`
(the duck-typed `CompactionEvent {sessionID, messages, result?}`), and
`config.ts` (`resolveConfig`/`resolveThresholds` are host-free; only the
*source* differs — Pi reads `pi.getSettings()` where OpenCode reads
`options.json` + the user file).

**The six ports → Pi seams** (each row is the port, the Pi seam, and what it
replaces from adapter #0):

1. `CollapseStrategy` → `pi.on("context")`. The handler rewrites **by return** —
   `ContextEventResult = { messages?: AgentMessage[] }` — or mutates in place;
   Pi restores prompt/tool state after the handler. Replace OpenCode's
   `event.messages` splice, same arithmetic from `view.ts`.
2. `Codec` → identity. The only work is strip/restore of the injected `mega_`
   ids, which `view.ts` already owns.
3. `Storage` → `pi.appendEntry("mega_state", {state, collapsed, summary})` as
   the durable write (fire-and-forget — the port's `set()` is void-compatible),
   reconstructed from `sessionManager.getBranch()` on `session_start`:
   branch-aware and resume-safe, so Pi never uses the KV blob at all. This is
   the one port where Pi is *better* than adapter #0, not just different.
4. `ToolBridge` → `pi.registerTool(ToolDefinition)`. Pi's definition carries
   name, description, `parameters` (the TypeBox schema), `promptGuidelines`,
   `reachesTools`, `exposure`, `annotations`, plus `execute`.
5. `CommandBridge` → `pi.registerCommand(name, {handler(args, ctx)})` plus a
   reply channel. Note `args` is a **string** in Pi, unlike OpenCode's
   invocation object. Reply via `ctx.ui.notify` (unverified — see below), with
   `sendMessage({…, triggerTurn: false})` as the fallback (`sendUserMessage`
   always triggers a turn, so it is *not* the channel).
6. `SessionLifecycle` → the context event's session id; init/dispose from
   `session_start` / `session_shutdown`. The factory itself holds no resources.

**Policy, compaction, nudge.** Standing policy rides
`pi.on("before_agent_start")`, mutating the `systemPromptOptions` sections
(OpenCode pushes into `event.system`). Compaction rides
`pi.on("session_before_compact")` → `{cancel: true, compaction: …}`, so no
summarizer call runs at all (OpenCode sets `event.result`). The stale nudge
rides the same `context` message array at a balanced tail — `view.ts`'s
arithmetic is reused verbatim.

**The glue split Pi forces.** This is the deferred Phase-1 split, and Pi is the
second adapter that makes it necessary rather than speculative:

- (a) the pure half of `adapters/opencode/context.ts` moves to
  `core/context.ts`, and `runContextTransform` takes an already-resolved
  `{system, tools, sessionID, model, messages}` and **returns** the tool
  wire-offer `{name, description, input}`; the one host-coupled line —
  assigning into the host's tool map — becomes each adapter's own.
- (b) `core/skill-state.ts` = `TOOL_NAME`, `TOOL_INPUT`, `parsePatch`,
  `unfence`, `describe`, `sessionIdOf`, `textResult` and the write semantics
  (patch → step → persist → ack); `adapters/{opencode,pi}/tool.ts` keep only
  their definition envelope (OpenCode's `codemode: false` options + output
  schema; Pi's TypeBox `parameters` + `exposure`).
- (c) `core/skill-state-command.ts` = `COMMAND_NAME`, `stateReport`,
  `turnIndex`, `stateBlock`; the adapters keep the envelope and the reply
  channel.

**Unverified before code** (recorded so no adapter is written against a
remembered shape): `ui.notify`'s location — most likely `ExtensionContext`'s
`ctx.ui`, not confirmed in the file read; `ToolDefinition`'s executable
signature body (an earlier reading records TypeBox params and
`execute(toolCallId, params, signal, onUpdate, ctx) → {content, details}`, but
it was not re-confirmed in this pass); and the Pi **package manifest** shape —
the install path is documented as "distributable as npm/git Pi packages", but
the manifest fields are unread. Design is settled; these three gate the code.

### Phase 3 — Tier 2 proxy daemon (the chosen Tier 2 route)

- [x] Daemon skeleton: HTTP server, SSE streaming passthrough, auth passthrough;
      the proxy stores only Σ — request bodies are rewritten in flight, nothing
      else is persisted. **Landed:** `src/proxy/server.ts` (`faa6dc3`) — pinned
      against a real HTTP boundary by the smoke's two proxy-daemon rows.
- [x] Anthropic Messages codec: `system` + `messages` handling, `tool_use` /
      `tool_result` adjacency (same pairing rule as `view.ts`), thinking-safe
      stripping/restoring. **Landed:** `src/proxy/codec-anthropic.ts` +
      `fixtures/codecs/anthropic.json` (4 cases), replayed byte-for-byte by the
      smoke's `codec round trip` row.
- [x] OpenAI Responses codec: item model (`function_call` /
      `function_call_output`), never orphan encrypted reasoning items.
      **Landed:** `src/proxy/codec-openai.ts` + `fixtures/codecs/openai.json`
      (5 cases), including the raw-`arguments` whitespace case.
- [x] Session identity: map host hints (metadata, headers) → session key;
      document per-host mapping; config fallback. **Landed:**
      `src/proxy/session.ts` + `src/proxy/store.ts` (`10ef2a5`) — the store is
      a dependency-free durable file store (no cache, temp-file-plus-rename
      writes), so the "SQLite" wording above is a planned shape, not what
      landed; SQLite stays a named follow-up.
- [x] MCP server exposing `skill_state`, sharing the same Σ store. **Landed:**
  `src/proxy/mcp.ts` (`30bc1a3`) — transport-free JSON-RPC dispatch pinned by the
  smoke's `proxy mcp` row; the session key derived with `sessionIdentityOf`
  verbatim so a write lands under the daemon's key.
- [x] Config file: port, upstreams, thresholds (mirror `options.json`), debug.
  **Landed:** `src/proxy/config.ts` (`0a7d852`) — the daemon's own keys with the
  core's collapse keys reached by **delegation** rather than duplication, so
  the strictness lives in one place and `debug` resolves once. `upstream` and
  `codec` have **no default on purpose**; `host` binds loopback; `dir` is
  optional (memory-only is a real mode). Pinned by the smoke's `proxy config`
  row.
- [ ] Claude Code setup doc: `ANTHROPIC_BASE_URL`; optional hook bridge for
      status display; `PreCompact` policy option (default: leave CC's compaction
      alone — our collapse keeps the surface small so it rarely fires).
- [ ] Codex setup doc: user-level `model_providers.<id>.base_url` +
      `wire_api = "responses"`; API-key requirement; ChatGPT-auth →
      hooks-degraded fallback documented.
- **Gate:** codec golden-transcript tests — **done** (`fixtures/codecs/`, 9
  cases byte-for-byte); live manual runs on CC and Codex with a visible collapse
  — **still owed, needs the operator's own hosts**; pairing-balance fuzz — **done**
  (`pairing balance fuzz`: 400 transcripts, 3034 safe cuts, 3125 unsafe cuts
  confirmed both directions, 348 collapses whole); daemon killed mid-stream —
  **done** (`daemon killed mid-stream`: a cut stream errors instead of
  completing, and Σ survives a real SIGKILL).

### Phase 4 — DeepSeek Harness adapter

- [ ] Timeboxed spike: fit as a **compaction backend** (`ctx.compaction`:
      `compactIfNeeded` / `compactNow` / `compactRegion`; summarizer =
      `render(Σ)`, no model call — the contract explicitly invites a non-model
      summarizer). Recommended route. Fallback if contract fit proves awkward:
      standalone plugin appending surface replacements directly with its own
      lock bracket.
- [ ] Σ as `SessionEventMap` events (`skillstate/*`, `ignorable`), folded on
      resume — moves Σ from an opaque KV blob into the replayable log.
- [ ] Collapse = one replacement message (`user/message` carrying `render(Σ)`)
      shadowing the superseded span; `sourceEventSeqs` cites every shadowed
      node; never touches the protected system head (node 0); serialize via the
      log-recorded bracket.
- [ ] Trigger: `agent/pre-step` at boundaries; `agent.runMaintenance()` for
      true-idle transactions.
- [ ] `skill_state` via `ctx.tools.register` (raw JSON Schema); `/skillstate`
      as a command plugin (precedent: `dsh-command-compact`); policy via
      `ctx.systemPrompt.section`; nudges via `agent.inject()`.
- [ ] Safe cuts via DSH's own `toolPairingBalancedBefore/After` (same invariant
      as `view.ts`; adopt theirs, keep ours as a cross-check in tests).
- **Gate:** `foldSurface` replay determinism over a session log; pairing checks;
  manual session.

### Phase 5 — Hardening, docs, distribution

- [ ] Cross-port conformance matrix in CI (core + adapters on ubuntu + windows;
      proxy codec tests; live-host runs stay manual).
- [ ] Docs: README per-host install; `docs/SPEC.md` for any behavior changes;
      feature-map pages; `DESIGN.md` module map.
- [ ] Distribution decision: single repo/package first (the OpenCode installer
      copies the tree; Pi/DSH install via git/path); split into workspaces only
      if individual npm publishing is wanted later.
- [ ] Release checklist per host.

## 5. Invariants (every adapter; never change)

- The durable transcript is never mutated — only the model-visible projection
  (request payload or recorded surface op).
- Never split a tool call from its result; collapse/insert only at balanced
  boundaries; never inject while a call is open.
- The runtime owns the schema: null deletes, unknown keys dropped, arrays
  replaced.
- Idempotence per request (request-rewrite adapters) / deterministic replay
  (surface replacement) — each adapter pins its equivalent form.
- Never touch the reference plugin
  (`C:\Users\mega\.config\opencode\plugins\opencode-feature-map-as-context`).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Proxy streaming/auth edge cases | passthrough-first; golden fixtures; no buffering |
| Codex ChatGPT-auth can't use custom providers | document API-key path; hooks-degraded fallback |
| DSH contract fit uncertainty | timeboxed spike; standalone fallback route |
| KV cache invalidation on collapse (all hosts) | inherent trade-off; keep the collapsed span minimal and stable; document |
| Scope creep across five targets | core-only feature rule; per-phase gates |

## 7. Out of scope

- Σ-vs-execution reconciliation (claims/evidence) — separate design question.
- Hosts beyond these four.
- Re-verifying the paper.

## 8. Verified research (provenance)

- **Pi:** `extensions/types.ts` — `ContextEvent { type: "context", messages }`
  fired before each LLM call, request-local, prompt/tool state restored by the
  host; `registerTool` / `registerCommand` / `appendEntry` / `sessionManager` /
  `before_agent_start` / `session_before_compact` seams verified.
- **DSH:** `packages/core/session/src/surface.ts` (surface fold, `surfaceOp`
  replace validations, system-head protection); `packages/compaction/compaction`
  (`CompactionEngine` contract, bracket protocol,
  `toolPairingBalancedBefore/After`, `ctx.tokenMeter`);
  `packages/core/agent/src/runtime-types.ts` +
  `packages/core/agent-loop/README.md` (`agent/request` is config-only;
  requests frozen and reconstructable from the log; no per-request message
  rewrite by design).
- **Claude Code:** hooks inject `additionalContext` and rewrite per-tool IO
  only; `PreCompact` blocks but cannot inject (issues #46191 / #50682).
- **Codex:** `openai_base_url` / `model_providers.*.base_url` +
  `wire_api = "responses"`, user-level config only; MCP stdio + streamable HTTP.

## 9. Next step (user's call)

1. ~~**Phase 3, slice 2: the daemon skeleton and session identity.**~~ **Landed**
   (`10ef2a5`, `faa6dc3`). Session identity was the only genuinely novel piece of
   Phase 3, because both landed adapters arrived with a native session id while
   CC and Codex send plain HTTP. What remains of Phase 3: `mcp.ts` (the
   `skill_state` MCP server sharing the store), `src/proxy/config.ts`, and the
   two setup docs — then the manual three-quarters of the gate (live runs on CC
   and Codex with a visible collapse, pairing-balance fuzz, daemon killed
   mid-stream). The payload-erosion work is deferred below, by user decision.
2. **Phase 3, slice 3+: mcp.ts, config, setup docs**, closing out the four-part
   gate (codec golden tests — done; live manual runs on CC and Codex with a
   visible collapse; pairing-balance fuzz; daemon killed mid-stream).
3. **DSH (Phase 4) spike** — still worth resolving while the core is a single
   shape, but Phase 3 is the chosen Tier 2 route and takes precedence.
4. **Adjust the roadmap** — edit `docs/ROADMAP.md` first (it ships as its
   own commit; follow-ups amend or add doc commits).

## 10. Deferred work — payload erosion (measured 2026-10-14; user-deferred)

A live `/skillstate now` reported `context 417369 -> 458371 tokens` with "Σ
already stands for turns 2-18; nothing left to collapse this pass" — a
41,002-token **increase** on a pass that folded nothing. The reply's third line,
"the next request carries the collapsed payload", was untrue on that pass and was
removed in `82f9d1c`; the erosion itself was deliberately left untouched and is
recorded here rather than fixed.

### What was measured

Four runs of the real `applyTransform` over synthetic transcripts, each final
payload decomposed into policy, Σ and the kept window (scratch probe, since
deleted; 4 chars ≈ 1 token):

| transcript | tool result | before | after | kept window | tool-result share | Σ |
|---|---|---|---|---|---|---|
| control | 2,400 ch | 15,433 | 3,631 | 3,207 | 75% | 124 |
| big | 120,000 ch | 603,433 | 121,231 | 120,807 | 99% | 124 |
| huge | 400,000 ch | 2,003,433 | 401,231 | 400,807 | 99.9% | 124 |
| live-like (18 turns, 3 passes) | 300,000 ch | 1,353,142 | 301,231 | 300,807 | 99.9% | 124 |

The collapse folded the **identical** span — turns 2-17, 48 messages — at 15,433
tokens and at 2,003,433 tokens. The mechanism is indifferent to payload size
because `min` is a **turn count**, and it counted correctly every time. The
erosion is entirely the window the collapse deliberately keeps, and in every big
run that window is 99-99.9% tool-result value (user 445 tok, assistant 362,
tool-call 42).

**Limitation, stated because it bounds the conclusion:** Σ measured only 124
tokens in all four runs, because the synthetic transcripts never accumulate
state. That figure says nothing about the live 41,002-token Σ.

### Two independent problems, two independent fixes

| cause | share of the live 417K | fix |
|---|---|---|
| kept window's tool results | ~90% (~376K) | a result-size threshold the collapse can act on |
| Σ's own accumulated text | ~10% (~41K) | condensation, or a size warning |

Fixing only the smaller one leaves the payload essentially unchanged, so the
condensation hypothesis — the obvious first answer — is refuted as the
**primary** fix.

### Option A — result-size threshold (the primary fix)

- Needs its own design decisions first: a per-result cap; whether oversized
  results are folded individually or replaced with a summary reference; and what
  the model actually loses when a 300,000-char result becomes a pointer.
- **Trap:** Σ is seeded from exactly the window that will survive and rendered
  **once** at injection. Folding part of the kept window changes what survives,
  so the seed and the fold must be ordered together — or the idempotence trap
  reappears in a new form, and "idempotent" quietly means "the last two passes
  agreed".

### Option B — measure Σ's own growth first

- The probe's 124 tokens proves nothing either way: drive the state store over
  many accumulating turns and measure `render(Σ)` for a real figure.
- Worth doing regardless, as the input to any size warning under Option A.

### Also still open

From `docs/OPTIMIZATIONS.md` (another session's report): F2 — 29 soft refusals
because `state_patch` arrived as malformed JSON, 26 of them a single extra
trailing brace, suggesting an enriched refusal naming the parse error and
position plus a tolerant repair for that one class; F1's second half (validation
after persistence); F3 (step fused with the payload); F4 (model-authored
objective garble); F5 (ack ambiguity); F6 (Σ growth — priced in the table above);
F7 (the installed copy lags the repo, so no fix here is live until reinstall).
