/**
 * `skill_state` over MCP: the tool for a host that cannot be reached in process.
 *
 * Claude Code and Codex reach this plugin two different ways. A wiring host
 * sends its provider traffic through the daemon in `server.ts`, which rewrites
 * the outbound request; the tool, for that path, is whatever the host already
 * has. But there are hosts with no request seam at all — and the operator may
 * want a model to maintain Σ from anywhere. MCP is the answer, and it is a
 * separate one: a registry of tools speaking JSON-RPC 2.0, over stdio or over
 * streamable HTTP, that this module owns entirely.
 *
 * **What this module owns, and what it does not.** It owns the JSON-RPC surface
 * — the handshake, the tool list, the dispatch, and the two transports. It does
 * *not* own a single line of the write semantics: that is
 * `src/core/skill-state.ts`, already host-free, and this is the third thin
 * wrapper around it after OpenCode's and Pi's. Nor does it own Σ: that is the
 * store, and the whole point of sharing it is that a write through MCP lands
 * under the same key the daemon's collapse reads from.
 *
 * **Why the JSON-RPC is hand-rolled.** `package.json` has no dependencies at
 * all, and that is load-bearing: this repo's gate has to pin on both CI
 * runners, and an SDK would put a runtime requirement and a lockfile churn into
 * a project whose only runtime requirement today is node itself. The method
 * set this server needs is small enough to be smaller than the SDK's
 * installation. So `node:http` and `node:readline` and nothing else.
 *
 * **The invariant that is easy to break and invisible when it is.** The session
 * key. A Σ written under the wrong key is a Σ that no request ever reads:
 * nothing errors, nothing logs, and the collapse silently keeps looking at an
 * empty record. So on HTTP the key is derived *exactly* as `server.ts` derives
 * it — `sessionIdentityOf`, verbatim, with the same header and the same
 * fallback — and on stdio, where there is no request to derive from, it is
 * passed explicitly rather than guessed.
 *
 * **The MCP transport's own session id is deliberately NOT the Σ key.**
 * `mcp-session-id` is allocated by a server on `initialize`, so a client that
 * reconnects is handed a fresh one. Keying Σ on it would resume every session
 * empty after a reconnect — precisely the failure this plugin exists to
 * prevent. Our key is the operator's `X-Mega-Skillstate-Session`, then the
 * host's documented hint, then the configured fallback. Two namespaced things
 * that both look like "a session" is the trap; they are not the same and are
 * not allowed to become the same.
 *
 * **Batching is refused, not half-supported.** The 2025-06-18 revision removed
 * JSON-RPC batching from MCP, and a server that answers the first half of an
 * array and drops the rest is worse than one that names the problem. An array
 * therefore gets `-32600`, which is what a current client reads as "this
 * server does not do that".
 *
 * @module mega-skillstate/proxy-mcp
 */

import type { Server } from "node:http"
import { createServer } from "node:http"
import { createInterface } from "node:readline"

import type { Storage } from "../core/ports.ts"
import {
  TOOL_INPUT,
  TOOL_NAME,
  TOOL_OUTPUT,
  skillStateDescription,
  writeSkillState,
} from "../core/skill-state.ts"
import { sessionIdentityOf } from "./session.ts"

/** Where a refusal goes, so it is visible rather than silent. */
export type McpLog = (line: string) => void

export interface McpServerOptions {
  /**
   * The Σ store, shared with the daemon. Absent means Σ lives in memory only
   * for this process, as on any host without a storage seam — which for an MCP
   * server means the tool answers and nothing survives the connection.
   */
  readonly storage?: Storage
  /** The session a request carrying no usable hint is filed under. */
  readonly fallbackSession: string
  readonly log?: McpLog
}

/**
 * A JSON-RPC 2.0 frame, in either direction.
 *
 * `id` is absent on a notification (hence `undefined`), `null` on a frame the
 * spec discourages but permits, and present otherwise. `result` and `error`
 * never both ride: the error member wins.
 */
export interface JsonRpcFrame {
  readonly jsonrpc: string
  readonly id?: string | number | null
  readonly method?: string
  readonly params?: Record<string, any>
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

/**
 * The protocol revisions this server will speak, newest first.
 *
 * `initialize` answers with the client's requested version when we can, so a
 * client pinning an older revision still negotiates rather than failing; when
 * we cannot, the newest is named and the client decides. The list is a
 * statement about what was implemented, not a claim about what every client
 * sends — the first live client is where that is confirmed.
 */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const

function negotiateProtocol(requested: unknown): string {
  if (typeof requested === "string" && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)) {
    return requested
  }
  return SUPPORTED_PROTOCOLS[0]
}

function frame(id: string | number | null | undefined, result: unknown): JsonRpcFrame {
  return { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), result }
}

function errorFrame(id: string | number | null | undefined, code: number, message: string): JsonRpcFrame {
  return { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), error: { code, message } }
}

/** The one tool this server exposes, as MCP asks for it. */
function toolList(): Record<string, any> {
  return {
    tools: [
      {
        name: TOOL_NAME,
        description: skillStateDescription(),
        inputSchema: TOOL_INPUT,
        outputSchema: TOOL_OUTPUT,
      },
    ],
  }
}

/**
 * One JSON-RPC frame, as one JSON-RPC frame — or `undefined` for a
 * notification, which is the one kind of frame that earns no reply.
 *
 * Transport-free by design. Both transports are thin readers of a socket, and
 * a boundary that can be pinned by calling a function is a boundary this repo
 * can pin at all: the smoke calls this directly, so a protocol regression
 * shows up as a row rather than as something only a live client would notice.
 *
 * @param message - the inbound frame, which must be an object rather than an array.
 * @param sessionID - the key Σ is addressed by, derived by the transport.
 * @param options - the store and the fallback, shared with the daemon.
 */
export async function dispatchMcp(
  message: Record<string, any>,
  sessionID: string,
  options: McpServerOptions,
): Promise<JsonRpcFrame | undefined> {
  const id = message["id"]
  const method = message["method"]

  // A notification names itself with the prefix. MCP's handshake is half of
  // them — `notifications/initialized` in particular — so answering one would
  // desynchronise a client that is waiting for nothing.
  if (typeof method === "string" && method.startsWith("notifications/")) return undefined
  if (typeof method !== "string") {
    return id === undefined ? undefined : errorFrame(id, -32600, "Invalid Request: method must be a string.")
  }

  try {
    switch (method) {
      case "initialize": {
        const params = message["params"] ?? {}
        return frame(id, {
          protocolVersion: negotiateProtocol(params?.["protocolVersion"]),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mega-skillstate", version: "0.3.0" },
        })
      }

      case "ping":
        return frame(id, {})

      case "tools/list":
        return frame(id, toolList())

      case "tools/call": {
        const params = message["params"] ?? {}
        const name = params?.["name"]
        if (name !== TOOL_NAME) {
          return errorFrame(id, -32602, "Unknown tool: " + String(name) + ". This server exposes " + TOOL_NAME + ".")
        }
        // The core takes plain values and decides everything about whether the
        // write is well formed; this is the same hand-off OpenCode's and Pi's
        // tools make. `arguments` is untyped from a socket, so a host that
        // omitted it entirely is answered rather than crashed on.
        const args = params?.["arguments"]
        const source: Record<string, any> = args !== null && typeof args === "object" && !Array.isArray(args) ? args : {}
        const outcome = await writeSkillState(
          {
            sessionID,
            state_patch: source["state_patch"],
            step: source["step"],
            summary: source["summary"],
          },
          { storage: options.storage },
        )
        return frame(id, {
          content: [{ type: "text", text: outcome.text }],
          // The structured record goes where MCP keeps one. A host that
          // renders it gets what OpenCode's `output` and Pi's `details` get.
          structuredContent: outcome.output,
          isError: outcome.output["kind"] === "error",
        })
      }

      default:
        return errorFrame(id, -32601, "Method not found: " + method)
    }
  } catch (error) {
    // An internal error is still a frame. A client that asked a question gets
    // an answer or it hangs, and a stack trace is not an answer.
    const message = error instanceof Error ? error.message : String(error)
    options.log?.("mcp " + method + " failed: " + message)
    return errorFrame(id, -32603, "Internal error: " + message)
  }
}

/**
 * One inbound line, as one outbound line — or nothing, for a notification.
 *
 * The stdio seam, transport-free. Newline-delimited JSON-RPC is the format,
 * so the line boundary *is* the frame boundary and a partial write is a parse
 * error rather than a half-answer.
 */
export async function handleMcpLine(
  line: string,
  sessionID: string,
  options: McpServerOptions,
): Promise<string | undefined> {
  if (line.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return JSON.stringify(errorFrame(null, -32700, "Parse error: the line is not valid JSON."))
  }
  if (Array.isArray(parsed)) {
    return JSON.stringify(errorFrame(null, -32600, "Invalid Request: this server does not answer batched frames."))
  }
  if (parsed === null || typeof parsed !== "object") {
    return JSON.stringify(errorFrame(null, -32600, "Invalid Request: a frame must be a JSON object."))
  }
  const reply = await dispatchMcp(parsed as Record<string, any>, sessionID, options)
  return reply === undefined ? undefined : JSON.stringify(reply)
}

/**
 * `skill_state` over streamable HTTP, as an `http.Server`.
 *
 * The key is derived per request, from this request, exactly as `server.ts`
 * derives it. That is not reuse for its own sake: it is the only way a write
 * through MCP lands under the key the collapse reads from, and a MCP server
 * that derived its own key would silently write a Σ nothing ever reads.
 *
 * @returns a server that answers POST with `application/json`. A GET is
 *          refused: this server holds no server-initiated stream to push, and
 *          saying so with a 405 is what a client needs to stop waiting.
 */
export function createMcpServer(options: McpServerOptions): Server {
  const log = options.log

  return createServer((request, response) => {
    const method = (request.method ?? "GET").toUpperCase()
    if (method !== "POST") {
      response.writeHead(405, { "content-type": "application/json", allow: "POST" })
      response.end(JSON.stringify(errorFrame(null, -32600, "This server answers POST only.")))
      return
    }

    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("error", (error: Error) => {
      log?.("mcp request failed: " + error.message)
      response.writeHead(400, { "content-type": "application/json" })
      response.end(JSON.stringify(errorFrame(null, -32600, "The request could not be read.")))
    })
    request.on("end", () => {
      const raw = Buffer.concat(chunks)
      const answer = (text: string, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" })
        response.end(text)
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw.toString("utf8"))
      } catch {
        answer(JSON.stringify(errorFrame(null, -32700, "Parse error: the body is not valid JSON.")), 400)
        return
      }
      if (Array.isArray(parsed)) {
        answer(JSON.stringify(errorFrame(null, -32600, "Invalid Request: this server does not answer batched frames.")), 400)
        return
      }
      if (parsed === null || typeof parsed !== "object") {
        answer(JSON.stringify(errorFrame(null, -32600, "Invalid Request: a frame must be a JSON object.")), 400)
        return
      }
      const body = parsed as Record<string, any>

      // Derived here, from this request, before anything is dispatched. The
      // order matters less than the sameness: the daemon and this server must
      // agree on the key, or one writes what the other never reads.
      const identity = sessionIdentityOf(body, request.headers, options.fallbackSession)

      dispatchMcp(body, identity.sessionId, options)
        .then((reply) => {
          if (reply === undefined) {
            // A notification is answered with a bare 202 and nothing else. The
            // body must stay empty, because a client that sent no id is not
            // looking for a frame and a sent one would be read as an error.
            response.writeHead(202)
            response.end()
            return
          }
          if (identity.origin !== "header") {
            log?.("mcp session " + identity.origin + " " + identity.sessionId)
          }
          answer(JSON.stringify(reply))
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          log?.("mcp dispatch failed: " + message)
          answer(JSON.stringify(errorFrame(body["id"], -32603, "Internal error: " + message)), 500)
        })
    })
  })
}

/** What starting a stdio server hands back, so it can be closed. */
export interface McpStdioHandle {
  /** Close the reader and finish the writer. Idempotent. */
  close(): void
}

/**
 * `skill_state` over stdio, newline-delimited on this process's own streams.
 *
 * There is no HTTP request here, so the key cannot be derived and is taken
 * explicitly: one connection, one key. That is the honest shape of stdio —
 * the alternative (guessing from the handshake's `clientInfo`) would key two
 * clients on their name and version, which is not a session by anyone's
 * definition. The same trap as the daemon's fallback applies and is documented
 * the same way: several conversations under one key share one Σ.
 */
export function createMcpStdio(options: McpServerOptions & { readonly sessionId: string }): McpStdioHandle {
  const reader = createInterface({ input: process.stdin, terminal: false })
  const out = process.stdout

  reader.on("line", (line: string) => {
    handleMcpLine(line, options.sessionId, options).then((reply) => {
      // A notification earns no line back. Writing an empty one would be read
      // by any line-delimited client as an empty frame.
      if (reply !== undefined) out.write(reply + "\n")
    }).catch((error: unknown) => {
      options.log?.("mcp stdio line failed: " + (error instanceof Error ? error.message : String(error)))
    })
  })

  return {
    close() {
      reader.close()
    },
  }
}
