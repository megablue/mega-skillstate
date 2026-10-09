# Compaction — own the summary with Σ

Status: shipped (v0.2) · Read when: the host asks for a compaction; a summary that lost the plan; Σ that never reaches a compaction; a restart before compaction.

User-visible behavior: `docs/SPEC.md` → Compaction. The design contract is `../../opencode-skill-state/SPEC.md`; the host seam is `../../opencode-skill-state/HOST-API-NOTES.md` ("Integrate next" §2).

## What it does

- On the host's `compaction` hook, the plugin composes the compaction message out of
  **Σ the model already maintained** through `skill_state`, plus a **deterministic seed
  sweep of the whole transcript** — and sets `event.result`, so the host makes **no
  summarization call of its own**.
- Seeds fill **holes only** (`record.seed`): a model-authored `files` entry survives a
  sweep that saw different tool calls.
- If the distilled Σ is empty (`hasMeaningfulState` false), `result` is left unset and the
  host summarizes in its own way.
- `event.messages` is **read and never written** — this plugin owns the content of the
  summary, not the transcript it came from.

## Map

- `src/compaction.ts` — `runCompaction(deps, event)`, `distill(deps, { sessionID, messages })`,
  `hasMeaningfulState` (the `MEANINGFUL` gate: `objective plan done findings files decisions open`),
  `seedPatch`; `CompactionDeps`, `CompactionReport`.
- `src/state.ts` — `stateStore` (durable; a cache miss is one `storage.get`), `seed`.
- `src/seed.ts` — `seedHintsFromMessages` (whole-transcript sweep) / `seedHints` (window).
- `src/prompts.ts` — `stateMessageText(state, collapsed)` — the same bytes the collapse injects.
- `src/index.ts` — registers `ctx.session.hook("compaction", …)` and disposes it with the rest.
- `src/types.ts` — `CompactionEvent` (`result?: { summary: string }`), `StorageDomain`.

## How & why

- **Deterministic, no model call.** The paper's runtime *validates and applies* `Σ ⊕ ΔΣ`;
  it never pays a model to read the trace. The live equivalent: the model maintains Σ
  semantically as it works, and compaction is where the trace is discarded and the state
  becomes the record. Recursion is the reason a distiller model cannot be called here.
- **Persisted first, seeded second.** The sweep sees the *whole* transcript (unlike the
  collapse's window scan), but it only fills holes, so the model's own account always wins
  over anything the runtime could infer.
- **The span comes back from the store.** A compaction request arrives on a fresh `event`,
  so the summary's "Collapsed: turns 2-3" line is read from the persisted span, not guessed.
- **The gate is meaningful content, not non-emptiness.** `working` and `step` alone are a
  bare environment, not an account of a session — the host's own summarizer knows more
  about that than a KV store does.
- **Never throws.** A refusal leaves `result` unset, which is exactly the host's default
  behaviour; the pass is wrapped and logs why it declined.
- **Trap — the hook is separate from the `context` hook.** Registering only the transform
  means the host still summarizes with its own model on every compaction; the two seams
  must both be registered for the plugin to own the summary.

## Config keys / UI

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | run the compaction pass at all |
| `collapseOlder` | `true` | `false` declines, so there is no Σ to hand back |
| `seedFromTools` | `true` | sweep the transcript for `files`/`working`/`step` |
| `trackTools` | `["read","edit","write","patch","glob","shell"]` | names the sweep reads |
| `debug` | `false` | log which path (owned/declined) each compaction took |

## Tests that pin it

`scripts/smoke.mjs` — **compaction** (result set to a Σ-named text, carries the persisted span,
a model-authored `files` entry survives the sweep, transcript untouched, `storage.set`
called), **compaction guard** (empty Σ → result unset), **compaction after restart**
(persisted Σ and span re-read from storage).

## Related

- `skill-state.md` — Σ, the ⊕ merge and the durable store this seam reads.
- `context-collapse.md` — the other seam, which injects Σ into every request.
- `skill-state-controls.md` — the `skill_state` tool that maintains Σ during the session.
