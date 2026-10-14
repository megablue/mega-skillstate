# Proxy MCP server — `skill_state` for a host with no request seam

Status: shipped (Phase 3, slice 4) · Read when: `skill_state` is called over MCP;
an MCP write lands under a key no request reads; a batch gets no reply;
`mcp-session-id` is being used as the Σ key; JSON-RPC needs pinning; a MCP client
hangs on `initialize`.

## What it does

- Exposes the one tool, `skill_state`, over JSON-RPC 2.0, on two transports:
  streamable HTTP and newline-delimited stdio.
- Shares the Σ store with the daemon, and shares its **key derivation** too —
  that is the whole reason this module exists as a proxy file rather than a
  standalone tool.
- Answers the MCP floor: `initialize`, `notifications/initialized` (no reply),
  `ping`, `tools/list`, `tools/call`. Anything else is a JSON-RPC error.
- Refuses batching and names the reason, rather than answering half an array.
- Owns no write semantics: `writeSkillState` is called, exactly as OpenCode's
  and Pi's tools call it. This is the third thin wrapper.

## Map

- `src/proxy/mcp.ts` —
  - `dispatchMcp(message, sessionID, options)` — the transport-free dispatcher;
    one frame in, one frame out (or `undefined` for a notification).
  - `handleMcpLine(line, sessionID, options)` — the stdio seam; one line to one
    line, because the line boundary *is* the frame boundary.
  - `createMcpServer(options)` — an `http.Server` answering POST. Derives the
    session per request, from that request.
  - `createMcpStdio(options)` — takes the session key **explicitly**, because
    stdio has no request to derive it from. Returns `McpStdioHandle.close()`.
  - `negotiateProtocol` (private) — `SUPPORTED_PROTOCOLS` newest-first; echoes a
    revision the server speaks, otherwise names its own.
  - `frame`, `errorFrame`, `toolList` (private) — and the `JsonRpcFrame`,
    `McpServerOptions`, `McpLog` types.
- `src/core/skill-state.ts` — the reused core: `writeSkillState`, `TOOL_NAME`,
  `TOOL_INPUT`, `TOOL_OUTPUT`, `skillStateDescription`.
- `src/proxy/session.ts` — `sessionIdentityOf`, reused verbatim so the HTTP
  transport's key *is* the daemon's key.
- `src/proxy/store.ts` — the `Storage` shared by the daemon and this server.

## How & why

**The session key is the entire design.** A Σ written under the wrong key is a
Σ that no request ever reads: nothing errors, nothing logs, and the collapse
keeps looking at an empty record. So on HTTP the key is derived by
`sessionIdentityOf(request, headers, fallback)` — verbatim, the same code path
`server.ts` takes — rather than by any MCP-specific rule. On stdio there is no
request, so the key is a constructor argument: one connection, one key, with the
daemon's own fallback trap documented alongside it (several conversations under
one key share one Σ, and a collapse in one empties the other's context).

**`mcp-session-id` is deliberately NOT the Σ key.** A server allocates it at
`initialize`, so a reconnecting client is handed a fresh one. Keying Σ on it
would resume every session empty after a reconnect — precisely the failure this
plugin exists to prevent. The two namespaced things both look like "a session";
allowing them to become the same is the trap, and the module's header states it.

**Why dispatch is transport-free.** Both transports are thin socket readers
around one function that takes a frame and returns a frame. That is not
elegance: it is the only shape this repo can *pin*, because a boundary that can
be exercised by calling a function needs no SDK, no client, and no live run to
have a failure mode. Before this pin existed `mcp.ts` was imported by nothing
and the gate was green — which proved nothing about it.

**Why the JSON-RPC is hand-rolled.** `package.json` has no dependencies at all,
and that is load-bearing: the gate must pass on both CI runners, and an SDK
would add a runtime requirement and lockfile churn to a project whose only
runtime requirement is node. The method floor here is smaller than an SDK's
install. `node:http` and `node:readline`, and nothing else.

**Batching is refused, not half-answered.** The 2025-06-18 revision removed
JSON-RPC batching from MCP, and a server that answers the first half of an array
and drops the rest is worse than one that names the problem. An array is
therefore `-32600`, which a current client reads as "this server does not do
that". A frame whose `method` is not a string is `-32600` for the same reason.

**A notification earns nothing.** MCP's handshake is half notifications, so
answering one desynchronises a client waiting for nothing — and on the HTTP
transport a notification is answered with a bare `202` and an *empty* body, since
a client that sent no id is not looking for a frame and a sent one would be read
as an error. On stdio, an empty line back would be read by any line-delimited
client as an empty frame.

**An internal error is still a frame.** A client that asked a question gets an
answer or it hangs, and a stack trace is not an answer: `-32603` with the
message, and the failure logged through the store's own log line.

## Config keys / UI

No keys are read from `options.json`; that is `src/proxy/config.ts`, still to
land. The constructor takes what it needs:

| Option | Required | Meaning |
|---|---|---|
| `storage` | no | the Σ store, shared with the daemon. Absent means Σ lives in memory only and nothing survives the connection. |
| `fallbackSession` | yes | the key an unidentifiable request gets; the same value the daemon is configured with. |
| `sessionId` (stdio only) | yes | one connection, one key — stdio has nothing to derive from. |
| `log` | no | where a refusal goes, so it is visible rather than silent. |

## Tests that pin it

`scripts/smoke.mjs` (`npm run smoke`):

- `proxy mcp` — the JSON-RPC row: `initialize` echoes a spoken revision and
  names an unspoken one as its own; `capabilities.tools` and `serverInfo` are
  present; a notification earns no reply; `ping` is an empty result; `tools/list`
  is one tool whose `inputSchema` is the core's own, byte for byte; a
  `tools/call` with a `state_patch` writes **through to the durable store** and
  the record is read back; a malformed `state_patch` sets `isError` and leaves Σ
  holding exactly what it had; an unknown tool is `-32602`; an unknown method
  `-32601`; a bad frame `-32600`; and the last case files a write under the
  daemon's own fallback key so the final assertion reads it back under that key.

The write-through is the row that matters, and it is why the store in the pin is
a real `createProxyStore` over a scratch directory: `writeSkillState` returns a
promise whether or not it persisted anything, so asserting on the reply alone
would pass a tool that answered correctly and wrote to nowhere. Every call in the
pin is awaited — the unawaited-async defect that once made a Pi assertion measure
a pending promise is not repeated here.

## Related

- [proxy-session-store.md](proxy-session-store.md) — the key derivation this
  module reuses, and the store it shares. Read this one first if the concern is
  *which* session a write belongs to.
- [proxy-codecs.md](proxy-codecs.md) — the other half of the proxy's wire
  vocabulary.
- [skill-state.md](skill-state.md) — the core the write semantics live in, and
  the `⊕` merge the MCP tool is subject to.
- `docs/ROADMAP.md` §4 Phase 3 — the checklist item this closes.
