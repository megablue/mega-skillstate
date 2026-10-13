/**
 * The proxy daemon: one local process standing between a wiring host and its
 * provider, rewriting the outbound request in flight.
 *
 * **Why a daemon at all.** Claude Code and Codex cannot rewrite their own
 * conversation history — their hooks inject context but cannot touch the
 * payload. A process that owns the base URL can do exactly what the in-process
 * adapters do: re-derive the outbound payload from the durable state, every
 * request, without the transcript ever being mutated. That is the whole trick,
 * and it is the same one `applyTransform` already implements for the other two
 * hosts.
 *
 * **What this module owns, and what it deliberately does not.** It owns the
 * envelope: reading the body, deciding which session the request belongs to,
 * finding the conversation inside the body, forwarding, and — the part that
 * matters most — never touching the response. It does *not* own translation;
 * that is the codec, and `src/proxy/codec-*.ts` is the only place a host's part
 * shapes are named. Nor does it own Σ; that is the store and the transform.
 *
 * **The one invariant that is easy to break and expensive to notice.** A
 * streaming response must be piped, never buffered. The moment this module
 * accumulates a response body to inspect it, every SSE stream stops being a
 * stream: the client sees nothing until the provider finishes, which can be
 * tens of seconds, and a kill mid-stream leaves a half-written body instead of
 * a clean close. So the response path has no body access at all — it forwards
 * status, headers, and a pipe.
 *
 * **Auth passes through verbatim.** This daemon holds no credentials of its
 * own. It copies the caller's `authorization` (OpenAI), `x-api-key` (Anthropic)
 * and `anthropic-version` headers onto the upstream request untouched, so a
 * token never exists in this process's memory beyond the lifetime of one
 * request, and nothing is persisted anywhere — the proxy stores only Σ.
 *
 * **Request bodies are read; response bodies are not.** A request body has to
 * be fully read to be rewritten, and these bodies are JSON. A response body is
 * never read here at all. Those are different decisions and they are the two
 * halves of "rewrite the outbound request, never the transcript".
 *
 * @module mega-skillstate/proxy-server
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { createServer, request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

import type { ResolvedConfig } from "../core/config.ts"
import { applyTransform } from "../core/context.ts"
import type { Codec, Storage } from "../core/ports.ts"
import type { Message, SystemPart } from "../core/types.ts"
import { sessionIdentityOf } from "./session.ts"

/** Where a refusal goes, so it is visible rather than silent. */
export type ProxyLog = (line: string) => void

export interface ProxyServerOptions {
  /** The port this daemon listens on. Pass 0 to let the OS choose. */
  readonly port: number
  /** The provider base URL every request is forwarded to. */
  readonly upstream: string
  /** How this host's parts are translated. One codec per upstream. */
  readonly codec: Codec
  /** The layered config the transform runs on. */
  readonly config: ResolvedConfig
  /** The session a request with no usable hint is filed under. */
  readonly fallbackSession: string
  /**
   * The Σ store. Absent means Σ lives in memory only, as on any host without a
   * storage seam.
   */
  readonly storage?: Storage
  /** The routed model's window, by `providerID/id`, when the caller knows it. */
  readonly windows?: ReadonlyMap<string, number>
  readonly log?: ProxyLog
}

/**
 * The fields a wiring host puts its conversation in.
 *
 * Anthropic spells it `messages`, Responses spells it `input`. Both are
 * documented, and neither host sends the other one, so this is a structural
 * read rather than a branch on which host is calling — the daemon never learns
 * which of the two it is serving, and the codec is what actually differs.
 */
const CONVERSATION_FIELDS = ["messages", "input"] as const

function conversationField(body: Record<string, any>): string | undefined {
  for (const field of CONVERSATION_FIELDS) {
    if (Array.isArray(body[field])) return field
  }
  return undefined
}

/**
 * The standing policy, as the core's `SystemPart` vocabulary.
 *
 * Anthropic sends `system` as an array of parts; Responses sends
 * `instructions` as one string. Both are carried, because the collapse policy
 * is part of what makes the outbound payload what it is.
 */
function systemOf(body: Record<string, any>): ReadonlyArray<SystemPart> {
  if (Array.isArray(body["system"])) return body["system"] as ReadonlyArray<SystemPart>
  const instructions = body["instructions"]
  if (typeof instructions === "string") return [{ type: "text", text: instructions }]
  return []
}

/** Auth headers, copied verbatim; each means the same thing on its own host. */
const AUTH_HEADERS = ["authorization", "x-api-key", "anthropic-version", "x-api-key-provider"] as const

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })
}

/** Never answer a client with a half-open connection: an upstream failure is a 502. */
function fail(response: ServerResponse, log: ProxyLog | undefined, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  log?.("the upstream could not be reached: " + message)
  if (!response.headersSent) {
    response.writeHead(502, { "content-type": "application/json" })
  }
  response.end(JSON.stringify({ error: { type: "proxy_upstream_error", message } }))
}

/**
 * A reverse proxy that rewrites what the host sends and forwards what the
 * provider returns.
 *
 * @returns the listening `http.Server`; `server.address()` carries the port
 *          actually bound, which is how a caller runs it on 0.
 */
export function createProxyServer(options: ProxyServerOptions): Server {
  const upstream = new URL(options.upstream)
  // One provider, one protocol: chosen once, here, rather than per request.
  const forward = upstream.protocol === "https:" ? httpsRequest : httpRequest
  const port = upstream.port === "" ? (upstream.protocol === "https:" ? 443 : 80) : Number(upstream.port)
  const log = options.log

  return createServer((request, response) => {
    // A GET or a body-less POST is not a conversation. Forward it and be done.
    const method = (request.method ?? "GET").toUpperCase()
    if (method !== "POST") {
      return forwardRaw(request, response, undefined)
    }

    readBody(request)
      .then((raw) => {
        let body: unknown
        try {
          body = JSON.parse(raw.toString("utf8"))
        } catch {
          // Not JSON: nothing to rewrite, so nothing to get wrong. A watermark
          // or a health check passes through untouched.
          return forwardRaw(request, response, raw)
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return forwardRaw(request, response, raw)
        }
        return rewrite(request, response, raw, body as Record<string, any>)
      })
      .catch((error: unknown) => fail(response, log, error))
  })

  // -------------------------------------------------------------------------
  // The two forwarding paths. They are separate because they are genuinely
  // different: one has a body to hand upstream verbatim, the other has a body
  // this process has already parsed.
  // -------------------------------------------------------------------------

  async function forwardRaw(request: IncomingMessage, response: ServerResponse, raw: Buffer | undefined): Promise<void> {
    const proxied = makeRequest(request, response, raw?.length)
    if (raw !== undefined) {
      proxied.end(raw)
    } else {
      request.pipe(proxied)
    }
  }

  async function rewrite(
    request: IncomingMessage,
    response: ServerResponse,
    raw: Buffer,
    body: Record<string, any>,
  ): Promise<void> {
    const field = conversationField(body)
    if (field === undefined) {
      // JSON, but not a conversation: a tool result echo, maybe. Forward as-is.
      return forwardRaw(request, response, raw)
    }

    // Which session this is, decided before anything is decoded: the key is
    // what the store is addressed by, and deriving it later would mean the
    // collapse ran against the wrong Σ.
    const identity = sessionIdentityOf(body, request.headers, options.fallbackSession)

    const decoded = options.codec.decode(body[field])
    // The transform mutates the array it is handed, by design: a pass re-derives
    // the payload from the raw transcript and Σ, which is what makes it
    // idempotent. `decode` returns a readonly array, so the daemon owns the
    // mutable copy it hands on — casting instead would let that in-place
    // mutation reach whatever array the codec returned to give away.
    const messages: Message[] = [...decoded]
    const report = await applyTransform(
      { config: options.config, windows: options.windows, storage: options.storage, log },
      {
        sessionID: identity.sessionId,
        model: body["model"],
        system: systemOf(body),
        messages,
        // A child agent's request is not distinguishable here — see
        // `session.ts` — so it is never claimed to be one.
        isChild: false,
      },
    )
    if (report.notes.length > 0) log?.("session " + identity.origin + " " + identity.sessionId + ": " + report.notes.join(" | "))

    // Encoded straight back into the field it came from, so the envelope the
    // host wrote survives the rewrite.
    const rewritten: Record<string, any> = { ...body }
    rewritten[field] = options.codec.encode(messages)
    const payload = Buffer.from(JSON.stringify(rewritten), "utf8")

    const proxied = makeRequest(request, response, payload.length)
    proxied.end(payload)
  }

  /**
   * The upstream request, with the auth headers and the route copied.
   *
   * The path is preserved exactly: `/v1/messages` and `/responses` are the
   * upstream's own routes, and this daemon does not have opinions about them.
   */
  function makeRequest(request: IncomingMessage, response: ServerResponse, contentLength: number | undefined) {
    const headers: Record<string, string | string[] | undefined> = { ...request.headers }
    // Hop-by-hop headers are this connection's business, not the upstream's:
    // forwarding `connection` or `transfer-encoding` would corrupt a stream.
    for (const hop of ["connection", "keep-alive", "transfer-encoding", "upgrade", "host"] as const) {
      delete headers[hop]
    }
    if (contentLength !== undefined) headers["content-length"] = String(contentLength)
    // Only the auth headers that actually arrived are forwarded. Setting an
    // empty `authorization` would be worse than setting none: some providers
    // reject a malformed token rather than ignoring it.
    for (const name of AUTH_HEADERS) delete headers[name]
    for (const name of AUTH_HEADERS) {
      const value = request.headers[name]
      if (value !== undefined) headers[name] = value
    }
    headers["host"] = upstream.host

    const proxied = forward(
      {
        hostname: upstream.hostname,
        port,
        path: request.url ?? "/",
        method: request.method ?? "GET",
        headers: headers as Record<string, string>,
      },
      (upstreamResponse) => {
        const through = { ...upstreamResponse.headers }
        // A streamed body must not promise a length: the provider ends it when
        // it ends, and a `content-length` here would truncate every SSE
        // response at the provider's first flush.
        if (String(through["content-type"] ?? "").includes("text/event-stream")) delete through["content-length"]
        response.writeHead(upstreamResponse.statusCode ?? 502, through)
        // Piped, not read: this is the invariant the whole response path exists
        // to keep. Backpressure propagates both ways, so a slow client slows a
        // fast provider rather than growing a buffer in this process.
        upstreamResponse.pipe(response)
      },
    )

    proxied.on("error", (error: Error) => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" })
      }
      response.end(JSON.stringify({ error: { type: "proxy_upstream_error", message: error.message } }))
    })

    return proxied
  }
}
