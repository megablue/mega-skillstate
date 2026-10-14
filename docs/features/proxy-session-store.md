# Proxy session identity & store — the key, and where Σ lives

Status: shipped (Phase 3, slice 2) · Read when: a proxy request arrives with no
session id; two conversations seem to share one Σ; Σ resumes empty after a
restart; a key becomes a filename; a truncated record.

## What it does

- Derives the session key a proxy request belongs to, because Claude Code and
  Codex send plain HTTP and neither sends a session id.
- Holds Σ durably, as the third `Storage` implementation after OpenCode's keyed
  blob and Pi's append log.
- Identity precedence: an explicit header, then the host's own hint
  (`metadata.user_id`, plus spelling variants), then a configured fallback.
- The fallback is a **string**, never `undefined`: "the host did not say" makes
  the transform leave the payload alone, which would skip the collapse.
- A `child` agent's request is answered `false` — the proxy cannot tell, and a
  guess collapses the wrong conversation.

## Map

- `src/proxy/session.ts` — `SESSION_HEADER` (`x-mega-skillstate-session`),
  `headerSessionId(headers)`, `sessionIdentityOf(request, headers, fallback)`
  returning `{sessionId, origin, hint?}`, `isChildSession()`, and the
  `SessionOrigin` type (`header` | `host-hint` | `fallback`). Private:
  `hintOf`, `sanitize`.
- `src/proxy/store.ts` — `createProxyStore({dir, log})` returning `Storage`
  (`get` / `set` / `remove`). Private: `pathFor`, and the read that decides what
  counts as a persisted state.
- `src/core/state.ts` — `stateKey` (the `state/` prefix), `PersistedState`
  (`{state, collapsed, summary}`), `load` (the reader that guards the shape and
  swallows a refusal), `persist` (the writer that swallows a refusal).
- `src/core/ports.ts` — the `Storage` port itself.
- `src/adapters/pi/storage.ts` — the second implementation, whose
  `stateKey("*")` aggregate is how a host without a listing primitive serves a
  restore.

## How & why

**Why identity is derived at all.** Both landed adapters were handed a session
id. The proxy is not: it is a base URL. The derivation is the whole contract —
the transform needs only a string, but it needs the *same* string every time,
because a drifting key resumes Σ empty and nothing in the request shows it.

**The precedence.** An operator-set header wins outright; a host's own
documented hint wins next; the configured fallback last. The fallback is a
string because `undefined` means "the host did not say", and the transform
leaves such a payload alone — the exact behaviour the no-session-id golden case
pins. For a one-user daemon the fallback is right; for several it is a trap,
since two conversations sharing one key share one Σ and a collapse in one
empties the other's context.

**The per-host hint shape is UNVERIFIED BY EVIDENCE.** It was written from
knowledge of the two APIs, not from a measurement of what Claude Code and Codex
actually send; the verifications spawned for it never arrived. The *derivation*
is pinned by fixtures this repo owns; the claim that a host *sends*
`metadata.user_id` is not. The ROADMAP's Phase-3 gate requires live manual runs
on both hosts, and that is where this is verified or corrected — a mismatch
there is a bug in the hint table, not in the arithmetic around it.

**A key is a filename.** That is why both modules flatten their input: a key
like `state/../../elsewhere` would otherwise write outside the store, and a hint
differing from another only in punctuation would be silently merged. Flattening
keeps them distinct and bounded. The smoke pins `../../elsewhere` flattening to
`elsewhere` — the trim removes the leading separator *with* the dots, which is
the safer answer, and the two invariant assertions (no `/`, no `.`) are what
actually matter.

**Why files, not the SQLite the roadmap names.** `node:sqlite` is an
experimental builtin that prints a warning to stderr on every import, and its
availability varies by node minor (22.5.0+, a flag on some). The proxy needs one
JSON value per session key inside one process, which is what the port declares,
so a dependency-free file satisfies it without an unpinnable runtime requirement
or warning noise on both CI runners. SQLite is a named follow-up, not a silent
omission.

**Three store decisions, each a failure that has already happened somewhere.**
Nothing is cached, because the MCP server (`src/proxy/mcp.ts`) is a real
separate-process case — its own `http.Server` and its own stdio reader over
this same directory — and a cache would be a correctness hazard. Every
write is a rename — a temporary file beside the target, then over it — because
an interrupted write leaves truncated JSON, the next restart reads it as
garbage, `load` refuses it, and the session silently resumes empty. And the key
is never trusted, because it arrives from whoever holds the store.

**One answer for three things.** A missing file, unparseable bytes, and a
value that is not a persisted state all read `undefined`. Keeping them the
same is what stops a truncated file being half-read into a live session, and a
refusal on `set` is already swallowed by `persist` — a store that will not
answer is a *degraded* store, not a broken turn.

## Config keys / UI

| Key | Default | Meaning |
|---|---|---|
| the fallback key | `"shared"` | what an unidentifiable request gets; shown as the `origin` `fallback` |
| `dir` | none (required) | where Σ lives; created on demand, nested paths included |

No keys are read from `options.json`: thresholds, the port and the upstreams are
the daemon's own, and they live in `src/proxy/config.ts` — see
[configuration.md](configuration.md) for the second surface and its defaults.

## Tests that pin it

`scripts/smoke.mjs` (`npm run smoke`):

- `proxy identity` — the header > host-hint > string-fallback row, which also
  pins that a traversal-shaped hint is flattened rather than honoured and that
  the same hint derives the same key twice.
- `proxy store` — the row over: a key that was never written is undefined, a
  round trip, unreadable bytes and a wrong shape both undefined, a rebuilt store
  over the same directory reading the same value, `remove` removing and being
  visible to the other handle, and a directory that does not exist being
  created. It closes by asserting a wild hint cannot write outside the store.

The last two assertions are the ones worth keeping: they only hold if
`sanitize` and `pathFor` agree, and a regression in either is invisible in every
other row.

## Related

- [proxy-codecs.md](proxy-codecs.md) — the codec half of the proxy; identity is
  decided *before* decode, because the key is what the store is addressed by.
- [skill-state.md](skill-state.md) — `stateStore`, `load`, `persist` and the
  swallow rules both new modules are written against.
- [context-collapse.md](context-collapse.md) — the transform that injects Σ once
  the key exists.
- `docs/ROADMAP.md` §9 — slice 2, and the live-run gate that verifies the hint.
