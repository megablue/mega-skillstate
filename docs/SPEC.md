# opencode-g-skill-state — behavior spec

User-visible behavior only: what the product does and what a user sees,
readable without knowing the code. Behavior belongs here even when the code is
where the reason for it lives — the reason, the mechanism and the traps live in
`docs/features/`, and process and hard rules live in `AGENTS.md`.

<!-- One section per user-visible area, in the order a user meets it. State what
happens, then the defaults and limits a user can observe, then what is out of
scope. Name the settings and their values, but not the code that reads them:
the feature page for the area owns the mechanism. -->

## Scope

`opencode-g-skill-state` is an OpenCode 2.0 CLI plugin that manages a session's
context window by carrying an **explicit, structured execution state (Σ)** instead of
the usual ever-growing conversation history.

Once a session has accumulated at least `min` turns, every later request the model
sees is rebuilt from three parts: the plugin's standing policy, the current Σ
(rendered as a compact JSON block placed right after the first user instruction),
and a short **recent window** of the newest `keepRecentTurns` turns kept verbatim.
The turns older than that window are **collapsed into Σ** and dropped from the
outgoing request, so the payload stays roughly constant in size instead of growing
with every turn. The model keeps Σ current by calling the `skill_state` tool and can
read it back with the `/skillstate` command.

It is for long agent sessions where append-only history would otherwise grow
quadratically. In practice, collapsing turns into Σ is **gated by turn count**
(`min` to start, `keepRecentTurns` kept), not by a token budget.

It deliberately does **not**:

- re-verify or reproduce the source paper's results (the paper is a reference,
  not a test target);
- touch the durable transcript — it only rewrites the request the host is about to
  send. A consequence a user can observe: **Σ lives in memory**, so a plugin or host
  restart re-expands the context to the raw transcript rather than restoring Σ.
  (Durable Σ across restarts, via `ctx.storage`, is a known planned follow-up, not
  shipped yet — see `HANDOFF.md`.)
- replace the host's own built-in compactor;
- handle multi-agent shared state with concurrent writes (a limitation the paper
  itself records);
- act on sub-agent (child) sessions unless `allowSubagentSessions` is turned on.

## Settings

User-configurable values live in the plugin package's `options.json`
(`opencode-skill-state/options.json`; an installed discovery copy carries its own).
Read the package `README.md` for install scope.

| Setting | Default | Range / clamp | Where |
| --- | --- | --- | --- |
| `enabled` | `true` | bool — master switch | `options.json` |
| `min` | `4` | integer ≥ 0 — **minimum turns** before the superseded prefix is collapsed into Σ | `options.json` |
| `keepRecentTurns` | `4` | integer ≥ 0 — newest turns kept verbatim beside Σ | `options.json` |
| `collapseOlder` | `true` | bool — collapse the superseded prefix into Σ | `options.json` |
| `protectFirstUserMessage` | `true` | bool — never collapse the first user instruction | `options.json` |
| `allowSubagentSessions` | `false` | bool — also manage sub-agent (child) sessions | `options.json` |
| `seedFromTools` | `true` | bool — keep `files`/`cwd`/`activeFiles`/`step` current from observed tool calls | `options.json` |
| `trackTools` | `["read","edit","write","patch","glob","shell"]` | tool names scanned when seeding | `options.json` |
| `nudgeWhenStale` | `true` | bool — remind the model to update Σ after a stretch with no new user message | `options.json` |
| `staleAfter` | `8` | integer ≥ 0 — steps with no new user message before the reminder | `options.json` |
| `manualCommand` | `true` | bool — expose the `/skillstate` command | `options.json` |
| `debug` | `false` | bool — log pass decisions to stderr | `options.json` |

Controls the model/user touch: the `skill_state` tool (the model writes a
`state_patch`, sets a key to `null` to delete it; keys the schema does not own are
dropped) and the `/skillstate` command (print the current Σ, the measured context,
and what is collapsed vs kept; `/skillstate now` collapses immediately).
