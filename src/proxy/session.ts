/**
 * Session identity for a proxy daemon: the key Σ is addressed by.
 *
 * **Why this is the novel part of Phase 3.** Both landed adapters arrived with a
 * native session id — OpenCode hands one on the event, Pi hands one on `ctx`.
 * Claude Code and Codex do not: they send plain HTTP to a base URL that happens
 * to be this daemon. So the id has to be *derived* from whatever the request
 * happens to carry, and the derivation is the whole contract — the transform
 * needs nothing more than a string, but it needs the *same* string every time
 * or Σ resumes empty.
 *
 * **The precedence, and why it is ordered this way.**
 *
 * 1. An explicit header. The operator set it, so it is the one hint that is
 *    deliberate. `X-Mega-Skillstate-Session` wins outright.
 * 2. A host's own documented hint. Anthropic's Messages API carries
 *    `metadata.user_id`; Codex's Responses API carries the same field. These are
 *    stable within a conversation and are the closest thing to a session id
 *    either host sends.
 * 3. A configured fallback. When nothing identifies the caller, a single shared
 *    session. It is the correct default for a one-user daemon and a documented
 *    trap otherwise: two conversations that map to one key share one Σ, so a
 *    collapse in one empties the other's context.
 *
 * **The per-host hint shape here is UNVERIFIED BY EVIDENCE.** It was written
 * from knowledge of the two APIs rather than from a measurement of what Claude
 * Code and Codex actually send, and the two verifications that were meant to
 * close that never arrived. The precedence is exercised by fixtures this repo
 * owns, so the *derivation* is pinned; the claim that a given host *sends*
 * `metadata.user_id` is not. The ROADMAP's Phase-3 gate already requires live
 * manual runs on Claude Code and Codex with a visible collapse, and that is
 * where this gets verified or corrected — treat a mismatch there as a bug in
 * the hint table, not in the arithmetic around it.
 *
 * Nothing here reads a request body beyond its top-level `metadata`, and the
 * codec never sees this module: identity is decided before decode, because the
 * key is what the store is addressed by.
 *
 * @module mega-skillstate/proxy-session
 */

/** The host's own hint, whichever spelling it uses. */
function hintOf(request: Record<string, any>): string | undefined {
  const metadata = request["metadata"]
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
  const candidates = [metadata["user_id"], metadata["userId"], request["user_id"], request["userId"]]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim()
  }
  return undefined
}

/**
 * Sanitize a hint into something that is safe as a key *and* as a path.
 *
 * The store turns a key into a filename, so a hint carrying a separator or a
 * traversal segment has to be flattened rather than rejected — rejecting would
 * silently merge two sessions that only differ in punctuation, and flattening
 * keeps them distinct as long as the flattening is injective on realistic
 * input. The trailing length cap keeps a pathological id from turning into an
 * unopenable filename.
 */
function sanitize(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64)
}

/**
 * Is this session a child agent's own conversation?
 *
 * The proxy cannot tell. Subagents reach a provider through the same base URL
 * with the same credentials, so the request looks identical; a header is the only
 * place a host could say so, and none of the two does. Answering `false` means a
 * subagent's Σ is managed as a main conversation — its own record, which is
 * harmless — and answering `true` on a guess would collapse a main conversation.
 * @returns always `false`; recorded so the assumption is visible.
 */
export function isChildSession(): boolean {
  return false
}

export type SessionOrigin =
  | "header"
  | "host-hint"
  | "fallback"

/** How a key was arrived at, for the log line and the tests. */
export interface SessionIdentity {
  readonly sessionId: string
  readonly origin: SessionOrigin
  /** The raw hint, before sanitizing, when there was one. */
  readonly hint?: string
}

/** The daemon's headers, looked at before anything in the body. */
export const SESSION_HEADER = "x-mega-skillstate-session"

/**
 * The one hint an operator can set by hand.
 *
 * `X-Mega-Skillstate-Session` — a header that exists only for this. It is
 * deliberately namespaced so no host's own traffic can set it by accident, and
 * deliberately undocumented as a *behaviour* of the plugin: the operator sets it
 * in their host's config when several conversations must not share a Σ.
 */
export function headerSessionId(headers: unknown): string | undefined {
  if (headers === null || typeof headers !== "object") return undefined
  const record = headers as Record<string, unknown>
  const raw = record[SESSION_HEADER] ?? record["X-Mega-Skillstate-Session"]
  if (typeof raw === "string" && raw.trim() !== "") return sanitize(raw)
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].trim() !== "") return sanitize(String(raw[0]))
  return undefined
}

/**
 * The session this request belongs to.
 *
 * The fallback is a string, not `undefined`, because `SessionLifecycle.sessionId`
 * returning `undefined` means "the host did not say" and the transform leaves a
 * payload like that alone. A proxy request with no usable hint is still a
 * conversation; the daemon's answer is to put it under one configured key.
 */
export function sessionIdentityOf(request: unknown, headers: unknown, fallback: string): SessionIdentity {
  const fromHeader = headerSessionId(headers)
  if (fromHeader !== undefined) return { sessionId: fromHeader, origin: "header" }

  if (request !== null && typeof request === "object" && !Array.isArray(request)) {
    const hint = hintOf(request as Record<string, any>)
    if (hint !== undefined) {
      const key = sanitize(hint)
      return { sessionId: key === "" ? fallback : key, origin: "host-hint", hint }
    }
  }

  return { sessionId: fallback, origin: "fallback" }
}
