# opencode-g-skill-state

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

One command, from this repository. There is no build step: the host resolves
`<plugin-root>/server` and loads the TypeScript source directly.

    npm run plugin:install            # user scope: every project on this machine
    npm run plugin:install:project    # project scope: this repository only

Both create a **link** rather than a copy, so the plugin under test is the one in this
working tree — an edit to `src/` is live on the next request, which is what makes a
development checkout usable. The user scope is `~/.config/opencode/plugins/`; the project
scope is `<this repo>/.opencode/plugin/`. Both discovery directories are read.

**Restart OpenCode after installing, and after any code change.** The host does not watch
module files; the profile loads them once per process. Editing `docs/` needs nothing.

To see where the plugin is discoverable from without changing anything:

    npm run plugin:status

To remove it:

    npm run plugin:uninstall            # user scope
    npm run plugin:uninstall -- --project   # project scope

The installer is idempotent: re-running `plugin:install` when the link is already correct
changes nothing, and a link pointing anywhere else — including at a directory that no
longer exists — is replaced rather than left to fail as a broken plugin.

> **Why the link is not a copy.** A junction that points at a deleted directory is
> discovered as a plugin that then fails to load, which is indistinguishable from a
> broken plugin. If you move or rename this checkout, re-run `plugin:install` to repoint
> it, and do so *before* deleting the old directory. Deleting a junction with
> `Remove-Item -Recurse` can follow the link and delete the repository's contents.

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

The approach this plugin implements — replacing an append-only conversation
history with an explicit, mutable execution state — comes from **"SKILL.state:
Scalable Long-Horizon Agent Skills"** by Sanket Badhe, Priyanka Tiwari and
Jonghyun Chung (arXiv:2608.26263v2, accepted at EMNLP). This plugin is a port
of that idea to the OpenCode host.
