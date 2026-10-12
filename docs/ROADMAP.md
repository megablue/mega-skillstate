# mega-skillstate — Roadmap (portability)

**Status:** active, Phase 1 not started.
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
    policy.ts            collapse policy (minTurns, keepRecent, staleAfter, force)
    tool.ts              skill_state semantics (parse patch, merge, persist, ack)
    command.ts           /skillstate semantics (branches, report content)
    types.ts             minimal core message/part vocabulary
    ports.ts             the six port interfaces
    conformance/         host-independent invariant checks + golden fixtures
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

### Phase 3 — Tier 2 proxy daemon (the chosen Tier 2 route)

- [ ] Daemon skeleton: HTTP server, SSE streaming passthrough, auth passthrough;
      the proxy stores only Σ — request bodies are rewritten in flight, nothing
      else is persisted.
- [ ] Anthropic Messages codec: `system` + `messages` handling, `tool_use` /
      `tool_result` adjacency (same pairing rule as `view.ts`), thinking-safe
      stripping/restoring.
- [ ] OpenAI Responses codec: item model (`function_call` /
      `function_call_output`), never orphan encrypted reasoning items.
- [ ] Session identity: map host hints (metadata, headers) → session key;
      document per-host mapping; config fallback.
- [ ] MCP server exposing `skill_state`, sharing the same Σ store.
- [ ] Config file: port, upstreams, thresholds (mirror `options.json`), debug.
- [ ] Claude Code setup doc: `ANTHROPIC_BASE_URL`; optional hook bridge for
      status display; `PreCompact` policy option (default: leave CC's compaction
      alone — our collapse keeps the surface small so it rarely fires).
- [ ] Codex setup doc: user-level `model_providers.<id>.base_url` +
      `wire_api = "responses"`; API-key requirement; ChatGPT-auth →
      hooks-degraded fallback documented.
- **Gate:** codec golden-transcript tests; live manual runs on CC and Codex with
  a visible collapse; pairing-balance fuzz (no split pairs across many
  simulated requests); daemon killed mid-stream → clean client error, Σ store
  intact.

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

1. **Phase 1 kickoff** — golden fixture capture, then core module moves;
   cheapest way to test the ports without changing behavior.
2. **DSH spike first** — resolve the backend-vs-standalone question while the
   core is still a single shape (removes the biggest architectural
   branch-point before extraction is banked).
3. **Adjust the roadmap** — edit `docs/ROADMAP.md` first (it ships as its
   own commit; follow-ups amend or add doc commits).
