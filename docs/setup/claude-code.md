# Claude Code — running the proxy daemon

How to point Claude Code at the daemon so the collapse happens on the way
out. One part is configuration, one part is optional, and one is a decision
about something Claude Code already does on its own.

## What you need first

The daemon running, and knowing where its Σ directory is. See
[the daemon's configuration](../features/configuration.md) for the two keys
with no default (`upstream` and `codec`) — a daemon that forwards nowhere is a
mistake rather than a tuning, and one that speaks the wrong wire sends an
empty conversation with nothing reporting it.

## Point Claude Code at the daemon

`ANTHROPIC_BASE_URL` is the one setting. Claude Code sends its traffic to the
base URL it is handed, so pointing it at the daemon's host and port puts every
outbound request through the collapse path:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
  }
}
```

The daemon answers on loopback by default, which is where this expects to
find it. Binding it anywhere else exposes a credential-forwarding endpoint to
a network that did not ask for one, so `host` stays `127.0.0.1` unless an
operator deliberately says otherwise.

Auth passes through verbatim: the daemon holds no credentials of its own and
copies `x-api-key` and `anthropic-version` onto the upstream request untouched.
A token never exists in its memory beyond one request, and nothing is
persisted anywhere — the daemon stores only Σ.

## The session key

Claude Code sends plain HTTP, so the request carries no session id. The daemon
derives one — an explicit `X-Mega-Skillstate-Session` header first, then
`metadata.user_id`, then the configured fallback. For a one-user daemon the
fallback is right; for several it is a trap, since two conversations sharing
one key share one Σ and a collapse in one empties the other's context.

That derivation is the whole contract, and the clause that matters most here:
**it is unverified by evidence.** It was written from knowledge of the
Anthropic Messages API, not from a measurement of what Claude Code actually
sends. The Phase 3 gate requires a live run on both hosts, and that is where
the hint table is confirmed or corrected — a mismatch is a bug in the hint
table, not in the arithmetic around it.

## The hook bridge (optional)

A hook that surfaces Σ's state — the step, the token count, what is being
collapsed — so the state is visible in Claude Code's UI rather than only in
the model's context. The transform already logs its decision when `debug` is
on; a hook bridge turns that into something a user sees.

It is optional because the collapse does not depend on it. The outbound
payload is what changes, and that happens whether or not anything is watching.

## PreCompact: what to do about Claude Code's own compaction

Leave it alone. That is the default and the recommendation.

Claude Code compacts on its own when its window fills, and the temptation is
to turn that off so this plugin's collapse is the only thing acting. It should
not be: this plugin's collapse keeps the surface small enough that CC's own
compaction rarely fires, so the two are not usually competing. Turning CC's off
removes the backstop for the case the collapse cannot reach — a payload
dominated by a few enormous tool results, which a turn-count gate has nothing
to fold — and leaves nothing between that and a request that will not fit.

If you do turn it off, you are trading a safety net you did not need for one
you did.

## What to check after wiring it up

1. A request arrives and the provider's answer comes back, unauthored and
   unmodified. If the daemon is misconfigured the answer is a 502, not a
   broken conversation — the daemon refuses rather than forwarding garbage.
2. Σ appears in a later request: the injected message is there, and the
   superseded span is gone. Both are visible in what the provider receives,
   which is why the daemon's own tests assert on what the *upstream* was
   handed rather than on its reply.
3. Tool calls and their results are still paired. The collapse only cuts at
   safe turn boundaries, and a request that lost a result is a request the
   model cannot answer.

## Status

The mechanism is built, pinned by the gate, and described here from the
roadmap's requirements — but **this configuration has never been run live.**
The live runs on Claude Code and Codex with a visible collapse are Phase 3's
own gate, and they are the part that has not happened. Treat the first real
run as the test, not the formality.
