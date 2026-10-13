# skill_state tool & /skillstate command

Status: shipped (v0.2) · Read when: the model updating Σ; `state_patch`; the ack a tool returns; a tool that is registered but never called; `/skillstate`; forcing a collapse; the stale reminder.

User-visible behavior: `docs/SPEC.md` → Compaction (the seam this feeds).

## What it does

- **`skill_state`** — the tool the model calls to write Σ. Input is a `state_patch` (JSON
  mutations; `null` deletes a key) plus optional `step`. The patch is an object, or a JSON
  string the runtime decodes to one — the host's pre-`execute` validation is a hard gate, so
  the string form is admitted by the schema and parsed by the tool (see the trap below). The
  runtime merges it (⊕, unknown keys dropped) and returns a compact ack naming what changed,
  what it dropped, and whether a string had to be parsed. No reply to the user is generated
  by a state write.
- **`/skillstate`** — prints the current Σ, the measured context, and a per-turn index of
  what is collapsed vs kept; **`/skillstate now`** forces a collapse on the current pass.
- A **standing policy** section tells the model Σ is the record and anything not written to it
  goes with the turn that knew it; plus a **stale reminder** after `staleAfter` steps with no
  new user message (only at a balanced tail).

## Map

- `src/core/skill-state.ts` — the host-free write semantics and tool vocabulary: `TOOL_NAME = "skill_state"`, `TOOL_INPUT` (the parameter contract, a union-typed `state_patch` so a quoted string is decoded rather than refused at the host's gate), `TOOL_OUTPUT`, `skillStateDescription`, `sessionIdOf`, `textResult`, `parsePatch`/`unfence`/`describe` (the tolerant read of `state_patch`), and `writeSkillState` — parse, validate `step`/`summary` **before** the store is opened, ⊕ the patch, handle `Σ.step`, persist, return the text ack and the structured output.
- `src/adapters/opencode/tool.ts` — `createSkillState({ storage })` only: the OpenCode envelope (`options: { codemode: false }`, a permissive `output`, the measured details above) whose `execute` maps args to `SkillStateWrite`, awaits `writeSkillState`, and wraps the result with `textResult`. No write logic remains here; it re-exports the core names.
- `src/core/skill-state-command.ts` — the command's host-free half: `stateBlock`, `turnIndex`, `stateReport` (all read only a `ContextDescriptor`), plus the reply phrasings `forcedReport`, `nothingYetReport`, `NOW_HINT`, and `COMMAND_NAME = "skillstate"`.
- `src/adapters/opencode/command.ts` — `createSkillStateCommand({ deps, payloadOf, reply })` only: it reads `invocation.prompt.text` (`now` means force), looks up the live payload, and answers through the injected `reply` channel. It is the seam a second adapter replaces — Pi takes a **string** arg and answers through `ctx.ui.notify`.
- `src/core/prompts.ts` — `SECTION_TEXT` (policy), `stateMessageText`, `nudgeText`,
  `toolDescription`, `schemaText`, `ackText` (the ack format).
- `src/core/config.ts` — `resolveOptions` (reads `options.json` and `ctx.options`), `resolveConfig`
  (strict: unknown keys throw), `resolveThresholds`, `DEFAULT_CONFIG`.
- `src/adapters/opencode/config.ts` — `userConfigPath()`, `ensureUserConfig()`,
  `USER_CONFIG_FILENAME`, `USER_CONFIG_ENV` — the host-shaped half (where the user-level file
  sits); the rest of the config machinery is `src/core/config.ts`.
- `src/adapters/opencode/index.ts` — registers the tool **and** the command; wires the `payloads` map and
  `ctx.storage` into both, so a `/skillstate now` pass is durable too.
- `scripts/install.ts` — the installer: `parseArgs`, `packageRoot`, `userPluginDir`,
  `projectPluginDir`, `discoveryDirs`, `isLink`, `installInto`, `uninstallFrom`, `run`,
  `statusLines`. Three modes (`--project`, `--remove`, `--status`) over one script.
  The discovery-directory name is **read from `package.json` by `packageName(root)`**, never
  written again — a rename is a one-line change to the manifest, not a hunt through four
  call sites.

## How & why

- **The ack is a feedback loop, not a courtesy.** It lists `changed:` keys and
  `dropped (not in the schema):` keys, so the model learns the schema from its own writes and
  stops trying to set keys the runtime will drop. It reads the report off the context pass, so
  the numbers match what the model just saw.
- **Trap — the host validates a call before `execute`, so `TOOL_INPUT` is the gate.** A
  patch quoted as a JSON string (`"{\"files\": ...}"`) is refused host-side with
  `Invalid arguments for tool "skill_state": - state_patch: Expected object` and never
  reaches the plugin; the plugin's own guard is only the second line. `state_patch` is
  therefore declared `["object", "string"]` (the host's schema conversion accepts type
  arrays) and `parsePatch` unfences and decodes the string, refusing anything not ultimately
  an object with a soft error that names what arrived. A whole session once looped on that
  refusal, retrying smaller patches, because the message read like a size problem; with the
  union the call lands and the ack reports the parse.
- **A state write is durable.** The tool's `execute` loads through `stateStore` (cache first,
  then `storage.get`) and `apply` writes through, so the write outlives the request it came
  from — and the collapse and compaction seams see it on the same pass.
- **`/skillstate now` is a forced pass, not a bypass.** It skips only the `min`-turn gate; the
  safe-cut rules, the protected head and the balanced-tail rule still apply. It orchestrates
  `applyTransform` directly and replies with the measured numbers.
- **Two hard-won registration facts.** A tool must be added **both** at the registry
  (`ctx.tool.transform`) *and* onto the wire (`event.tools[TOOL_NAME]` in the context hook with
  its `input` **and** `output` schema) — a tool only on the registry is never available to the
  model, and one called without an `output` schema makes the host reject it. There is no
  `noReply`/agent flag; write-paths return plain output and the user simply is not addressed.
- **The command reads the same measured context** the transform used (the `payloads`
  map), so `/skillstate` cannot disagree with the payload the model is about to receive.
- Traps: tool **output values must be copied** before shipping so a host mutation can't touch
  plugin-owned state (stale after repair); never log tool results (they can impersonate the
  model); `manualCommand: false` removes the command but leaves the tool and the pass intact.
- Trap — the tool's `execute` runs against the **durable** store, so a write from a session
  whose request never reached the context hook still lands (a session created outside a turn).

### Install & uninstall (`scripts/install.ts`)

- **The install is a copy, not a link.** The host discovers a plugin by resolving
  `<root>/server(.ts|.js)` inside `~/.config/opencode/plugins/` (user scope) or
  `<project>/.opencode/plugin/` (project scope). Nothing else is required: no global config
  entry, no build step, no dependency to install — the package has zero runtime
  dependencies, so a copy needs no `node_modules`. So the installer's whole job is to place
  a copy of the shippable set in the right directory, which is why it is a script rather
  than a package manifest.
- **The copy beats the link on every axis that survives a restart.** The host imports the
  plugin's module graph once per process, so a link and a copy are equally live only after a
  restart — the old claim that an edit to `src/` is live on the next request was never true
  (the installer's own `--help` has always said "A code change needs an OpenCode restart").
  What the copy adds: the install is a real directory in the shape a user gets, it cannot
  break because a working tree moved, and it can be **compared** against the repository, so
  a stale install is diagnosable drift rather than a plugin quietly running old code.
- **The shipped set is read from the manifest.** `shippableFiles(root)` reads `package.json`'s
  `files[]` and always appends `package.json` itself — `"type": "module"` is what makes the
  host load the `.ts` as ESM, and a copy without its manifest fails to load. Every entry is
  checked against the tree, so a manifest listing a missing file is an install-time error
  rather than a silently incomplete copy.
- **Idempotence is measured on bytes.** `installInto` compares `sha256` hashes first: a copy
  matching the shipped set exactly is left alone (`action: "current"`, nothing written); a
  drifted copy is replaced wholesale (`"updated"`), because a reinstall is an upgrade.
  `driftReport(path, root)` names what differs — `missing`, `changed`, `extra` — which is the
  diagnostic a link could never give, since a junction always agreed with itself.
- **Trap — an old install is a junction, and a junction is deleted without recursion.** The
  installs in both scopes were junctions to the repo root before the copy switch, and they
  are still there until the first reinstall. `removeLink` uses `lstatSync` to tell a link
  from a real directory and issues a bare `rmSync` for a link: recursing follows the junction
  and deletes the *target's* contents — this repository included. Never `Remove-Item
  -Recurse` one by hand. A real directory is deleted with the recursive form, which is safe
  because no link is followed.
- **Trap — a drifted copy is a real state, not a broken one.** `--status` reports a junction
  as "from before the copy switch; install replaces it", and a copy as in-sync or drifted
  with named counts. A drifted copy installs fine and runs old code; the fix is a reinstall,
  not a hunt for the reason discovery stopped working.
- **A code change needs a restart.** The host does not watch module files; the plugin row is
  resolved once per server process. `plugin:status` reports what the *filesystem* says, which
  is why it can disagree with a running host that has not re-scanned. See the restart trap in
  `HANDOFF.md`.
- **npm swallows flags.** `npm run plugin:uninstall -- --project` — without the second `--`,
  `--project` is consumed by npm and never reaches the script.

## Config keys / UI

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch — off returns the disposer before any registration |
| `nudgeWhenStale` | `true` | remind the model to update Σ after a stretch with no new instruction |
| `staleAfter` | `8` | steps with no new user message before the nudge |
| `manualCommand` | `true` | expose `/skillstate` |

## Tests that pin it

`scripts/smoke.mjs` — the `skill_state` ack (`updated → step 5 (changed: objective, findings,
step) · dropped (not in the schema): not_a_key`), **the durable write** it persists, the
**string-tolerant read** (the schema admits `["object", "string"]`; a bare and a fenced JSON
string both write and the ack says the string was parsed; a broken string and a non-object
string refuse with Σ and the step untouched), `/skillstate` prints Σ + the per-turn index,
`/skillstate now` forces a pass leaving pairs intact, stale reminder appended only at a
balanced tail.

## Related

- `skill-state.md` — the schema + ⊕ merge the tool drives.
- `context-collapse.md` — the transform the command reports on.
- `configuration.md` — where the values for the keys above come from.
