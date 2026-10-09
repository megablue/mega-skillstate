# opencode-skill-state

An OpenCode 2.0 plugin that bounds a session's context window with an **explicit,
structured execution state (Σ)** instead of an append-only conversation history.

## What it does

The paper's agent sees `(P, Σ_t, O_t)`: the fixed procedure, a structured state, and the
latest observation. A coding agent on OpenCode cannot work that way literally — it is a
tool-use loop, and the host rebuilds the whole durable transcript on every request — so
this plugin gets as close as the host allows:

- A **state message** early in the request carries Σ as compact JSON: the objective, the
  plan, what is done, the findings, the files, the decisions, the approaches already ruled
  out, and what is open.
- The turns Σ has already absorbed are **collapsed into it** rather than sent. The
  outbound payload becomes roughly *policy + Σ + a rolling recent window* instead of the
  whole history.
- The model writes Σ through the **`skill_state`** tool. The patch is a dictionary merge
  the runtime validates: a key the schema does not own is dropped, a `null` deletes a key,
  arrays replace wholesale.
- A deterministic seed keeps Σ's floor honest — which files were touched, from where, how
  far along the work is — so a model that never spends a call on bookkeeping still gets a
  state worth reading. A seed only ever fills a hole; the model's own word wins.

Nothing here edits your transcript. The pass rewrites the payload the host is about to
send, and it is re-derived on every request, so the conversation is always intact.

**Σ is durable.** It is stored per session under the plugin's own storage, so a restart
brings the state back rather than re-expanding the context. A store that cannot be
reached degrades to in-memory state and says so in the log; it never breaks a session.

**When the host compacts, the plugin answers with Σ.** The compaction message is the
model's own state plus a deterministic sweep of the transcript — no summarization call
of the plugin's own. When the distilled state has nothing to say, the host summarizes in
its own way.

## Install

The host resolves `<plugin-root>/server`, and this package needs no build step — the
TypeScript source is loaded directly.

**User scope** (every project):

```
robocopy . "%USERPROFILE%\.config\opencode\plugins\opencode-skill-state" *.ts *.json *.md /E /XD node_modules docs .git .opencode
```

That copies the shippable subset only — `server.ts`, `src/`, `options.json`,
`package.json`, `package-lock.json`, `README.md`, `SPEC.md`, `HOST-API-NOTES.md`. The package
is the repo root, so "this directory" would otherwise mean the whole repo, paper and `.git`
included. Run `npm install` in the destination only if you want the typecheck and smoke test
there too; the host loads the TypeScript source directly and needs no node_modules.

**Project scope** (one project only):

```
robocopy . "<project>\.opencode\plugin\opencode-skill-state" *.ts *.json *.md /E /XD node_modules docs .git .opencode
```

Both discovery directories are read (`.opencode/plugin/` and `.opencode/plugins/`).

## Using it

Nothing to enable: the transform runs on every request of every session once the plugin
is discovered. What you get:

- a `fmac_state` message near the head of the request, carrying Σ and naming the span it
  replaced;
- the `skill_state` tool, offered to the model on every request;
- `/skillstate`, which prints Σ, the measured context, the model's window, how many recent
  turns are kept, and a per-turn index of what was collapsed and what is still verbatim.
  `/skillstate now` forces a collapse on the next pass.

To see what the pass decided, check `/skillstate`.

## Config

Options are read from the plugin entry's `options` when there is one, and otherwise from
`options.json` at this package's root — so a directory install is configured by editing
that file. Every key is validated on load, and an unknown key is an error rather than a
silently ignored typo.

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | Run the pass at all. |
| `min` | `4` | Turns a session must have before its prefix is collapsed. |
| `keepRecentTurns` | `4` | Turns always kept verbatim — the live tool loop's working memory. |
| `collapseOlder` | `true` | Collapse the superseded prefix into Σ. |
| `protectFirstUserMessage` | `true` | Never drop the session's first instruction. |
| `allowSubagentSessions` | `false` | Transform inside a subagent's own session. |
| `seedFromTools` | `true` | Keep Σ's floor current from the recent window. |
| `trackTools` | `read, edit, write, patch, glob, shell` | Tools the seed reads. |
| `nudgeWhenStale` | `true` | Remind the model to commit Σ when it has gone stale. |
| `staleAfter` | `8` | Steps since the last instruction before the reminder is eligible. |
| `manualCommand` | `true` | Register `/skillstate`. |
| `debug` | `false` | Log each pass's decision. |

The two rules that are never traded away, whatever the configuration: a cut only ever
lands on a turn boundary where no tool call is waiting for its result, and a message is
never appended while a call is open at the tail. A too-aggressive cut that splits a tool
pair is a bug, not a tuning.

## Σ schema

```
{
  "objective":    the current sub-goal, one line
  "plan":         steps, each { step, status: done|active|todo|blocked }
  "done":         what is completed, one line each
  "findings":     key facts and discovered flags; hypotheses verified or ruled out
  "files":        path -> what we know or did there
  "decisions":    semantic or architectural decision and why, one line each
  "errors_tried": approach that failed and why, so it is not repeated
  "working":      the environment: { cwd, branch, activeFiles }
  "open":         blockers, open questions, concrete next actions
  "step":         integer, the current step index
}
```

## Checks

```
npm install
npm run typecheck     # tsc --noEmit, strict
npm run smoke         # the pinning test: Σ injection, safe collapse, idempotence, ⊕ merge
```

## Provenance

The host API shapes this plugin relies on were measured against OpenCode
`@opencode/plugin@2.0.26` on this machine, cross-checked against the working reference
plugin `opencode-feature-map-as-context` — including its safe-cut helpers, which are
ported rather than reinvented.
