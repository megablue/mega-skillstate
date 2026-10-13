# Proxy codecs — the wire's vocabulary, as the core's

Status: shipped (Phase 3, slice 1) · Read when: a proxy payload is not what the
model sent; a round trip fails on key order; `arguments` came back re-serialised;
an encrypted reasoning item or a thinking block reached the core; `Codec`.

## What it does

- Translates a host's conversation array into the core's `Message` /
  `ContentPart` vocabulary and back, so the collapse arithmetic is written once
  against the core and nowhere else.
- The proxy is the **only consumer that is not already speaking the core's
  vocabulary**: Pi's parts *were* the core's, so `Codec` was identity there.
- `decode` → `ReadonlyArray<Message>`; `encode` → the host shape; `strip` /
  `restore` take out and put back content the core must not read.
- `host` is the conversation array (`request.messages`, `request.input`), never
  the whole request body — `system` / `instructions` sit outside it and are the
  daemon's to carry.
- No host conditional exists in core: a host that spells a tool result
  differently is decoded here and re-encoded here, and both directions are
  pinned byte-for-byte without a live host or an API key.

## Map

- `src/core/ports.ts` — the `Codec` interface: `decode(host)`, `encode(messages)`,
  `strip(host) → {stripped, removed}`, `restore(host, removed)`. Its comment
  states the round-trip contract.
- `src/proxy/codec-anthropic.ts` — `decode`, `encode`, `strip`, `restore`, the
  `codec` object and a default export. Private helpers `toolNames` (a first pass
  collecting `tool_use` names, because a result cites an id but not a name),
  `decodePart` / `encodePart`, `decodeToolResult` / `encodeToolResult`,
  `decodeMessage` / `encodeMessage`, `dropInjectedId`, `fixedType`.
- `src/proxy/codec-openai.ts` — the same five exports. Helpers `callIdOf`,
  `parseArguments`, `summaryText`, `callNames`, `decodeTextPart` /
  `encodeTextPart`, `decodeMessageItem`, `decodeItem`, `flatItem` (the message-key
  walk), `firstPart`, `encodeMessage`, `dropInjectedId`, `fixedType`,
  `stringify`.
- `src/core/types.ts` — the vocabulary both codecs target, and the
  `readonly [key: string]: any` index signature that makes the round trip
  possible.
- `src/core/view.ts` — `INJECTED_ID_PREFIX`, imported rather than re-declared.
- `fixtures/codecs/anthropic.json` — schema 1, 4 cases.
- `fixtures/codecs/openai.json` — schema 1, 5 cases.

## How & why

**Spread, never construct.** A host's extra fields survive a decode only if the
codec spreads the host part instead of building a fresh one, and because a
spread keeps an existing key in its original position, **key order survives
too**. `JSON.stringify` is order-sensitive and the gate compares strings, so a
part rebuilt as `{type, text, summary}` fails the comparison on identical data.
This is why `fixedType` exists at all: TS will not prove `type: string` through
a `Record<string, any>` spread, so it is restated *after* the spread — which
keeps the key in its original position anyway.

**The flat item list.** Responses is not a message array. Each top-level item
becomes one core `Message`, and the item's own key order *is* the message's key
order; the spread happens at the message level and the core part is the core's
own shape. `encode` then walks `Object.keys` of the message, skips the `role`
decode added, and substitutes the core content array for whatever the item held
there. `function_call` → role assistant, `function_call_output` → role user, so
**both hosts hand the core the identical shape**, which is what lets
`view.ts`'s pairing arithmetic stay host-free.

**Three traps, each pinned by a fixture case.**

- OpenAI `arguments` is a JSON **string**: decode parses it for the core, but
  encode carries the raw string back. `JSON.stringify(JSON.parse(s))` is not
  `s` when the original has whitespace, so a codec that re-serialises changes
  bytes on identical data. The fallback to stringify exists only for a part the
  transform itself created.
- A Responses reasoning item can carry its own `content` blocks, which collide
  with the core's content array — decode stashes them on the part under a
  private `itemContent` key and `flatItem` puts them back at the exact key
  position they came from.
- An injected Σ message carries this plugin's `mega_` id. The durable transcript
  is never touched, but the **outbound** payload must not carry a private marker
  id to a provider that would reject a field it does not know — hence
  `dropInjectedId` in both directions' `encode`.

**Strip/restore, and why it must be able to fail.** Anthropic thinking blocks and
OpenAI reasoning items are provider state: the core must not read them, yet a
request that drops them is rejected on the next turn. Both codecs record
positions and reinsert in **reverse** record order so each index is still valid,
and both clamp an out-of-range index rather than throwing. `restore(strip(host))
=== host` alone would pass a strip that removed nothing, so the two opaque
cases declare `expectRemoved` and the replay also asserts the stripped payload
differs from the host's.

## Config keys / UI

None. The codecs read no configuration: thresholds, the port and the upstream
are the daemon's (Phase 3, later slice) and belong to `src/proxy/config.ts`.

## Tests that pin it

`scripts/smoke.mjs` (`npm run smoke`):

- `codec round trip` — the row that reports `9 case(s) replayed byte-for-byte`.
- `codec anthropic: plain-turns` / `tool-pair` / `thinking-and-signature` /
  `unknown-fields`.
- `codec openai: plain-turns` / `function-call-pair` / `encrypted-reasoning` /
  `function-call-raw-arguments` / `unknown-fields`.

Three assertions run per case: `checkPairing` on the **decoded** form (a codec
that reorders or drops a part can split a pair even when the host's transcript
was balanced), byte identity on `encode(decode(host))`, and
`restore(strip(host)) === host` plus the `expectRemoved` count and the
stripped-differs-from-host check. Re-capture is a hand edit — these fixtures are
written, not captured, because there is no host to capture from and the shapes
worth pinning are deliberately awkward.

## Related

- [context-collapse.md](context-collapse.md) — the transform the codecs feed.
- [skill-state.md](skill-state.md) — the vocabulary the codecs translate into.
- `docs/ROADMAP.md` §3 and Phase 3 — the proxy architecture and its four-part
  gate, of which the codec golden tests are the first item, now met.
