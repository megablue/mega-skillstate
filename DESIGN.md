# mega-skillstate — design contract

> Applies the **SKILL.state** runtime idea (see `docs/arXiv-2608.26263v2/acl_latex.tex`)
> to OpenCode 2.0: bound the context window with an **explicit structured execution
> state Σ** instead of an append-only conversation history.
>
> This project is not about re-verifying the paper; it implements the *context-window
> management* ideas from it on top of the real OpenCode CLI.

## The idea, and the honest mapping

**Paper:** at step *t* the model sees only `A_t = (P, Σ_t, O_t)` — the immutable
procedural spec `P`, a structured execution state `Σ_t`, and the latest observation
`O_t`. The model emits `(R_t, ΔΣ_t, a_t)`; the runtime *validates* then applies
`Σ_{t+1} = Σ_t ⊕ ΔΣ_t` (dictionary merge, **null deletes a key**), and **discards the
reasoning trace `R_t` forever**. Prompt stays `O(1)`, cumulative tokens `O(T)` not `O(T²)`.

**OpenCode reality (v2.0.26):** the model is a tool-use agent. The host rebuilds the
full durable transcript as `event.messages` on *every* request, and the outbound
messages must keep each `tool-call` paired with its `tool-result`. We cannot
synchronously run a private "distiller model" inside the context hook (recursion). So:

| Paper concept | Implementation here |
|---|---|
| `P` (spec + policy) | **static system parts**: a stable, cacheable policy + the Σ-schema + the `skill_state` contract |
| `Σ` (structured state) | a per-session, schema-driven JSON object, **injected** as a message before the recent window |
| `⊕` merge (null deletes) | the merge operator in `state.ts`, applied to model-written `state_patch` |
| `R_t` discarded | the model's *reasoning* is never distilled by the plugin; only what the model commits via `skill_state` survives. Superseded history is dropped from the payload. |
| `O_t` (latest observation) | a **rolling recent window** (`keepRecentTurns`) kept verbatim so the live tool loop stays coherent |
| `O(1)` prompt | the superseded prefix is **collapsed into the Σ message**; outbound payload ≈ `P + Σ + recent window` |
| deterministic runtime validation | `skill_state` validates the patch against the schema (drop unknown keys; keep pairing safe) |

**The one hard constraint, and how we respect it.** The durable transcript is *never*
mutated. A pass rewrites the **outbound payload** only, so the transform is re-derived
on every request from the raw transcript + in-memory Σ. Cuts happen **only at safe turn
boundaries**: never split a `tool-call`/`tool-result` pair, never append inside an open
pair, and (by default) never drop the first user instruction. This is exactly what the
reference plugin proves works on this host.

## Ground-truth API (v2.0.26) — authoritative source

Model every host call on the working plugin
`C:\Users\mega\.config\opencode\plugins\opencode-feature-map-as-context` (`src/*`). Its
`types.ts` shapes were measured against the live host.

- Plugin entry: `export default { id, setup } satisfies Plugin.Plugin` (`import type { Plugin } from "@opencode/plugin"`; host package `@opencode/plugin@2.0.26`). `server.ts` → `export { default } from "./src/index.ts"`.
- `setup(ctx): Promise<() => Promise<void>>`. `ctx = { location:{directory}, options, session, tool, command, model }`.
- **`ctx.session.hook("context", async (event) => {...})` → Registration** — *the seam*.
  `event = { sessionID, agent, model, system: SystemPart[], messages: Message[], tools }`.
  **Mutating `system` / `messages` in place changes what the model sees.** The durable
  transcript is untouched; the transform is re-applied every request.
- `ctx.session.prompt({ sessionID, text, delivery? })`, `ctx.session.compact({ sessionID, delivery? })`,
  `ctx.session.get({ sessionID })` (→ `{ parentID?, ... }`), `ctx.session.context({ sessionID })`.
- `ctx.tool.transform(editor => editor.add(def))`; `ctx.command.transform(editor => editor.add(def))`;
  `ctx.model.transform(editor => editor.list())` (each `{ id, providerID, limit:{context} }`).
- Dispose pattern: collect `Registration[]`, return a disposer that disposes newest-first.
- Message: `{ id?, role, content: ContentPart[], metadata? }`. Parts:
  `{type:"text",text}` · `{type:"reasoning",text}` · `{type:"tool-call",id,name,input}` ·
  `{type:"tool-result",id,name,result:{type,value}}`. SystemPart: `{type:"text",text}`.
- Injected messages carry an `mega_` id prefix (see `view.ts` `INJECTED_ID_PREFIX`,
  `isInjectedMessage`); the reference injects them as `role:"user"` text messages.
- No token meter is exposed to plugins → estimate **4 chars/token** (`measureContext`,
  `roughTokens` in the reference `pass.ts`).
- Reusable safe-cut helpers in the reference `view.ts`: `viewOf`, `turnMap`, `turnsOf`,
  `balanceCuts` (→ safe `cuts` + `inFlight` open-call count), `selectPrunableRange`,
  `relatedAndUnresolved`. Reuse/adapt these — do not reinvent pairing-safety.
- Store per-session state **in memory**, LRU (`MAX_SESSIONS`), keyed by `sessionID`.
- Options live in `options.json` at the package root; read via `resolveOptions(ctx.options, OPTIONS_PATH)`.

## Σ schema (default, coding-agent domain; configurable)

```
{
  "objective":      "current sub-goal, one line",
  "plan":           [ { "step": "…", "status": "done|active|todo|blocked" } ],
  "done":           ["completed, one line each"],
  "findings":       { "<name>": "key facts / discovered flags; hypotheses verified or ruled out" },
  "files":          { "<path>": "what we know or did there" },
  "decisions":      { "<name>": "semantic/architectural decision and why, one line each" },
  "errors_tried":   { "<name>": "approach that failed, and why (so it is not repeated)" },
  "working":        { "cwd": "…", "branch": "…", "activeFiles": [<paths>] },
  "open":           ["blockers, open questions, concrete next actions"],
  "step":           <integer current step index>
}
```
(Mirrors the paper's InterCode schema `discovered_flags / tested_hypotheses /
active_files / working_dir / cmd_summary`, re-cut for coding.)

## The `context`-hook transform (the crux — implement exactly)

On each `context` event for session `S`:

1. **Idempotent static policy.** Ensure `event.system` carries P (policy + schema +
   `skill_state` contract). Dedupe by exact-text match so a provider prefix cache stays
   warm (same pattern as the reference's `SECTION_TEXT` push).
2. **Ensure the tool is offered.** If `event.tools["skill_state"]` is absent, add it
   (registry ≠ wire — same lesson the reference documents: a tool only reachable via
   `tool.transform` is never called).
3. **Guard.** If `isChild` (session has `parentID`) and `allowSubagentSessions !== true`, return.
4. **Re-apply from scratch** (durable transcript is raw again): start from
   `event.messages`; drop any previously-injected `skill_state` messages (`mega_` state id).
5. **Measure** `tokens = measureContext(system, messages)`; resolve the model window via
   `model.transform` list (`windowOf`).
6. **Collapse the superseded prefix** (when `collapseOlder` and past any `min`):
   - `view = viewOf(messages)`, `turns = turnsOf(...)`, `balance = balanceCuts(view)`.
   - `keepStartIdx` = first message index at/after turn `currentTurn - keepRecentTurns + 1`
     that is a **safe cut boundary** (`balance.cuts`) and **after** the protected head
     (first real user message, when `protectFirstUserMessage`).
   - The superseded region `(headEnd .. keepStartIdx-1)` is replaced by **one injected
     message** `{ id: "mega_state", role: "user", content:[{type:"text", text}] }` where
     `text` = a clear wrapper + **Σ rendered as compact JSON** + a one-line note naming
     the collapsed turn span. Do **not** collapse the protected head itself.
   - Never split a tool pair: only cut at `balance.cuts`; never append a state/notice
     message while `inFlight > 0` at the tail.
7. **Deterministic seed** (when `seedFromTools`): after collapse, light-scan the kept
   recent window's `tool-call`/`tool-result` parts for `trackTools` to keep
   `working.cwd`, `working.activeFiles`, `files`, `step` minimally current — so Σ tracks
   reality even before the model calls `skill_state`. Seeded keys are *only* filled if
   not already set (never clobber model-authored Σ).
8. **Optional stale nudge:** if `stepsSinceUser` is high and `nudgeWhenStale`, one short
   static-agnostic reminder appended **only at a balanced tail** (`inFlight === 0`).
9. **Never throw.** The whole pass is wrapped so a failure only logs (`debug`) and lets
   the uncollapsed request through.

## `skill_state` tool (the model's write channel — the ⊕ operator)

- `name: "skill_state"`. No reply to the user is generated by a state write.
- `input` schema (zod-shape like the reference `TOOL_INPUT`):
  `{ state_patch: object | JSON string (JSON mutations; **set a key to `null` to delete it**), step?: integer, summary?: string }`.
- The union is deliberate: the host validates the caller's arguments **before** `execute`
  runs, so a quoted JSON string must be admitted there or it is refused with no chance to be
  parsed. `execute` then decodes it — unfence, `JSON.parse`, require a plain object — and
  answers anything else with a soft error that names what arrived; the ack appends a note
  when a string had to be parsed.
- `execute(input, toolCtx)`:
  1. `sessionID = sessionIdOf(toolCtx)`; load per-session Σ.
  2. If `input.step != null`, set `Σ.step`.
  3. `Σ = merge(Σ, state_patch)` — recursive dict merge; a `null` value deletes the key.
  4. **Validate**: keys not in the schema are dropped (runtime owns the schema → guards the
     paper's "Premature State Overwrite / deletion" failure mode). Arrays replace wholesale
     (no deep array merge). Persist Σ, bump step.
  5. Return a compact ack: `textResult("skill-state updated → step N (changed: k1, k2, …)")`.

## Commands

- `/skillstate` (guarded by `manualCommand`): print Σ (compact JSON) + measured context,
  window, `keepRecentTurns`, and a per-turn index showing what is collapsed vs kept. Then
  an interactive subcommand `now` to force a collapse this pass.

## Module layout

```
server.ts        -> export { default } from "./src/index.ts"   (host resolves <root>/server)
package.json     (done)  tsconfig.json (done)
README.md        install (project .opencode/plugin + global ~/.config/opencode/plugins) + config
src/types.ts     adapt the reference types.ts; add StateSchema, StateRecord, SkillStateEvent
src/config.ts    options.json defaults + resolveOptions/resolveConfig/resolveThresholds
src/schema.ts    default Σ schema, render(Σ)->compact JSON, validateKeys, merge(⊕)
src/state.ts     per-session Σ store (LRU), get/set/merge, seeded updates
src/seed.ts      deterministic extraction of files/cwd/step from tool parts
src/view.ts      port viewOf/turnMap/turnsOf/balanceCuts/selectPrunableRange (+ injected-id helpers)
src/context.ts   the transform above (inject Σ, collapse superseded prefix, seed, nudge)
src/prompts.ts   SECTION_TEXT policy, schema text, tool description, ack/command formats
src/tool.ts      skill_state tool definition + execute
src/command.ts   /skillstate
src/index.ts     setup(): register context hook + tool + command; return disposer
```

## Acceptance criteria (fixer must self-verify before returning)

1. `npm install` then `npx tsc --noEmit` passes with **no errors** (strict).
2. A `scripts/smoke.mjs .` that: loads the built module shape, feeds a synthetic
   `context` event whose `messages` contains a head user + 20 synthetic assistant/tool
   turns with a *safe* tool-call/result pairing, and asserts (a) Σ is injected before the
   recent window, (b) the superseded prefix is collapsed so outbound messages shrink to
   ≈ head + Σ + `keepRecentTurns`, (c) **no tool-call/result pair is ever split**, (d) the
   transform is idempotent (running twice yields the same payload). Print the numbers.
3. `skill_state` merge honours null-delete and drops unknown keys.

## Out of scope / non-goals

- No re-validation of the paper's claims.
- Not touching the durable transcript; not replacing the host's own compactor
  (`useHostCompaction` is an optional, off-by-default fallback only).
- Not wiring sub-agent shared-state concurrency (paper §Limitations).
