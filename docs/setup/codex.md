# Codex — running the proxy daemon

How to point Codex at the daemon so the collapse happens on the way out.
Codex's configuration is a provider block rather than an environment
variable, and one field in it decides whether the daemon ever sees the
traffic at all.

## What you need first

The daemon running, and knowing where its Σ directory is. See
[the daemon's configuration](../features/configuration.md) for the two keys
with no default (`upstream` and `codec`) — a daemon that forwards nowhere is
a mistake rather than a tuning, and one that speaks the wrong wire sends an
empty conversation with nothing reporting it.

## Point Codex at the daemon

A provider block in the user-level `~/.codex/config.toml`, and then a model
that uses it:

```toml
model = "mega-gpt-5"

[model_providers.mega]
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
```

Two fields carry the whole thing.

**`base_url`** is the daemon's host and port, so every outbound request goes
through the collapse path. The daemon answers on loopback by default, which
is where this expects to find it; binding it anywhere else exposes a
credential-forwarding endpoint to a network that did not ask for one.

**`wire_api = "responses"`** is the one that must not be guessed wrong. The
daemon has a codec per wire and it decodes the body it is handed according
to the codec it was configured with. Codex speaks the Responses API, whose
conversation lives in `input` and whose items are flat — not Anthropic's
`messages` with its block-shaped parts. Point a Responses-shaped upstream at
the Anthropic codec and the decode produces an empty or mangled conversation,
which the daemon forwards upstream as-is. Nothing errors, because nothing is
structurally impossible to forward. So the codec is named in the daemon's
config and has no default, for exactly this reason.

The daemon's own `upstream` is where the rewritten request then goes — the
real provider, not this config. Codex sends to the daemon; the daemon
forwards to the provider the operator configured it with.

## The API key

A provider block needs one, and it belongs in the *daemon's* configuration
as the upstream it forwards to, not in Codex's. The daemon passes Codex's
credentials through verbatim on the way to the provider and holds none of its
own, so a token never exists in its memory beyond one request and nothing is
persisted anywhere — the daemon stores only Σ.

That is also why the key question has a one-sided answer: whatever Codex
sends, the daemon forwards. It does not need its own, and giving it one would
be a second credential to leak rather than one fewer.

## If you are signed in with ChatGPT — the degraded path

Codex can authenticate with a ChatGPT subscription instead of an API key, and
when it does, **it does not consult a custom provider block.** That is the
trap this section exists for: the config above looks correct, the sign-in is
correct, and no request ever reaches the daemon. The collapse does not happen
and nothing says so — the model simply runs with an unbounded context, which
is the state this plugin does not exist to produce.

So, plainly:

- **ChatGPT subscription sign-in** → requests go to Codex's own endpoint, the
  daemon is bypassed, and the plugin has no effect. This is the
  hooks-degraded fallback: what you get is Codex's native compaction only.
- **API key** → the provider block is honoured, requests reach the daemon, the
  collapse runs, and Σ is maintained.

There is no configuration that makes both true at once, because the decision
of where to send traffic is Codex's and it is made from which credential it
holds. If the plugin appears to do nothing, check the sign-in type before
checking anything else.

## The session key

Codex sends plain HTTP, so the request carries no session id. The daemon
derives one — an explicit `X-Mega-Skillstate-Session` header first, then
`metadata.user_id`, then the configured fallback. For a one-user daemon the
fallback is right; for several it is a trap, since two conversations sharing
one key share one Σ and a collapse in one empties the other's context.

That derivation is the whole contract, and the clause that matters most here:
**it is unverified by evidence.** It was written from knowledge of the
Responses API, not from a measurement of what Codex actually sends. The
Phase 3 gate requires a live run on both hosts, and that is where the hint
table is confirmed or corrected — a mismatch is a bug in the hint table, not
in the arithmetic around it.

## What to check after wiring it up

1. A request arrives and the provider's answer comes back. If the daemon is
   misconfigured the answer is a 502, not a broken conversation — the daemon
   refuses rather than forwarding garbage.
2. Σ appears in a later request: the injected message is there and the
   superseded span is gone, visible in what the provider received rather
   than in Codex's reply.
3. Tool calls and their results are still paired. The collapse only cuts at
   safe turn boundaries, and a request that lost a result is a request the
   model cannot answer.

## Status

The mechanism is built, pinned by the gate, and described here from the
roadmap's requirements — but **this configuration has never been run live.**
The live runs on Claude Code and Codex with a visible collapse are Phase 3's
own gate, and they are the part that has not happened. Treat the first real
run as the test, not the formality.
