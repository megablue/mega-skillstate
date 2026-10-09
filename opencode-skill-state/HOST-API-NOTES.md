# Host API notes — OpenCode 2.0.26 (measured)

Provenance: `lib-1` doc/source research **plus** the installed reference plugin
`C:\Users\mega\.config\opencode\plugins\opencode-feature-map-as-context` (its
`src/types.ts` shapes were measured against this live host). Authoritative for
2.0.26; ignore v1 (`@opencode-ai/plugin`, `Hooks`, `chat.params`) vocab — different,
incompatible API. The stale git branch `2.0` is also v1-shaped; the real v2 line is the
`v2.0.x` tags. Repo `sst/opencode` redirects to `anomalyco/opencode`.

> This file is the build-side host reference. Product behaviour stays in `docs/SPEC.md`;
> the mechanism/traps feature page owns the *why*; this file owns the *exact API surface*.

## Confirmed — the current foundation is valid (do not re-derive)

- Entry (module validator accepts either shape): `export default { id, setup } satisfies Plugin.Plugin`
  (`import type { Plugin } from "@opencode/plugin"`), or `Plugin.define({ id, setup })`.
- `setup(ctx) => Cleanup | Promise<Cleanup>`; dispose registrations newest-first.
- **`await ctx.session.hook("context", (event) => { … })` → `{ dispose }`.** `event =
  { sessionID, agent, model, system: SystemPart[], messages: Message[], options, tools }`.
  **Mutating `event.messages` / `event.system` (and `options`, `tools`) in place changes the
  outgoing call only — the durable transcript is never touched**, so re-apply every request.
  Fires on the agent loop *including* tool continuations.
- Message (LLM layer, `Message[]`): `{ id?, role: "system"|"user"|"assistant"|"tool", content: ContentPart[] }`.
  Parts: `{type:"text",text}`, `{type:"reasoning",text}`, `{type:"tool-call",id,name,input}`,
  `{type:"tool-result",id,name,result:{type,value}}`. `SystemPart = {type:"text",text}`.
- `ctx.tool.transform(ed => ed.add(def))`, `ctx.command.transform(ed => ed.add(def))`,
  `ctx.model.transform(ed => ed.list())` (each `{id, providerID, limit:{context}}`).
- `ctx.session.{prompt, compact, get, context, create, …}` — the 15-method domain.
  NOTE field renames docs-vs-source (we don't use them, listed for completeness):
  `session.command` field is `name`; `session.interrupt` field is `resume`.

## Integrate next — upgrades surfaced by lib-1 (the real SKILL.state centrepiece)

1. **Durable Σ via `ctx.storage`.** `ctx.storage.{get,set,remove,scan}` — plugin-scoped,
   durable KV namespaced by plugin id. Replace the in-memory `SessionRecord` store with a
   `ctx.storage` insert + in-memory LRU cache. Key by session (e.g. `state/<sessionID>`).
   Async → `await` in the context hook. *This is the difference between "re-expands on
   restart" and a true persistent execution state.*
2. **Own the distillation via the `compaction` hook.** `await ctx.session.hook("compaction",
   (event) => { … })`. `event` carries the transcript being summarised and a **mutable
   `result`**: setting `event.result = { summary }` **skips the host's summary model call
   entirely** and your string is persisted as the compaction message. This is where Σ is
   distilled, persisted (`ctx.storage.set`), and fed back as `render(Σ)` — the real
   "project reasoning into structured state, then discard the transcript" step. Without it
   we only have the model-written `skill_state` tool + deterministic collapse.
   The hook also exposes `event.messages` (same shape as `context`).
3. **Σ injection primitive — `Message.system()`.** `import { Message } from "@opencode/ai"`;
   `Message.system(content)` → a `{ role: "system", content:[…] }` message you can place at a
   chosen index in `event.messages`, distinct from the `event.system` preamble. Cleaner than
   the `fmac_`-id **user**-role injection the reference plugin uses (that works too — it runs
   on this host — so this is a choice, see "Open design decisions").
4. **Flush before idle via `ctx.event.subscribe({ signal })`.** async iterator over a tagged
   union keyed on `type`; e.g. `session.execution.succeeded` / `.failed` / `.interrupted`.
   Abort in the returned cleanup. (Optional.) Nudge the model to commit `skill_state`, or
   flush a derived Σ, when a session goes idle.
5. **Durable injected turn (optional):** `ctx.session.synthetic({ sessionID, text, description })`
   persists a `[Synthetic context]: …` model-visible turn — if Σ should also show up in the
   transcript, not just the outbound payload.

## Data model nuance

- Two layers. Persisted transcript = `SessionMessage.Info[]` (from
  `ctx.session.context({sessionID})`); the LLM request = `Message[]`. **Inside the `context`/
  `compaction` hooks `event.messages` is already the projected `Message[]`** — no
  `Assistant.cost/tokens/retry` there. If needed, read `ctx.session.context` separately.
- Parts are **not** independently addressable in v2 (no `part.update/remove`); they live
  inside assistant `content`. A tool call is `{type:"tool-call", id, name, input}` paired with
  `{type:"tool-result", id, name, result}` by `id` — our pairing-safety rule stays.
- There is **no `step-start`** part type; synthetic faces are text/media/tool-call/tool-result/
  reasoning/compaction/effort.

## Gotchas that bite

- **Host auto-compaction threshold is NOT tunable from a plugin** (`auto`/`buffer`/`keep` are
  internal). We bound the context ourselves in the `context` hook and *own* the compaction
  *result* via the hook — that's the levers we do have.
- Native (provider-side) compaction bypasses our `compaction` hook's message edits on the
  "summarize older" step; `event.result` still applies. Edge case.
- Hooks run in **registration order**; a later plugin's edits are what an earlier one sees.
  Register early.
- When history must be flattened, the compaction hook's edits to the *existing* summary
  message can be dropped — persist Σ to `ctx.storage` so we re-derive, don't rely on in-place
  edits to the prior summary surviving.
- `ctx.event.subscribe` must be aborted in `setup`'s returned cleanup.
- Discovery dirs for a local plugin: **`.opencode/plugin/` and `.opencode/plugins/`** (both).
  Loader resolves `<root>/server` then `<root>/index` (`.ts` before `.js`); `package.json`
  `exports` (`.`, `./server`) honoured. Resolution never executes plugin code.

## Built-in recap template (overlaps our Σ — reconcile naming)

v2.0's default summary prompt already asks the model for: **Objective / Requirements /
Decisions / Work State (Completed/Active/Blocked) / Next Move / Relevant Files / Important
Context.** This maps closely onto our Σ schema (`objective`/`done`/`active`/`decisions`/
`working.activeFiles`/`open`). When we `set event.result` ourselves we skip it, but if we
ever co-exist, keep our field names aligned so a compaction message reads the same either way.

## Open design decisions (resolve in the integration pass)

- Injection **role**: keep the host-proven `fmac_` **user**-role injected Σ message (matches
  the reference plugin, pairing-safe with `inFlight === 0` tail rule) vs switch to the
  semantically-cleaner `Message.system()`. Decide by what inserts cleanly between a protected
  user head and a rolling tool-paired recent window without breaking role ordering.
- **Σ store**: `ctx.storage` + LRU cache vs LRU-only. Recommend `ctx.storage` + LRU cache.
- Whether `/skillstate` and the `skill_state` tool remain the model's write channel, or the
  `compaction` hook becomes the sole distiller (recommend: both — tool for live in-session
  patches, compaction hook for the periodic/whole-history distillation + persistence).

## Pointer
Full digest in the `lib-1` transcript; essentials are here. Feature page + `docs/SPEC.md`
carry the WHY and the user-visible behaviour; this file is the build-side API surface.
