#!/usr/bin/env node
/**
 * The pinning test for mega-skillstate's hard rules.
 *
 * It builds a fake host, loads the plugin exactly the way the OpenCode loader does,
 * and drives a synthetic `context` event whose transcript is a head instruction plus
 * twenty turns of correctly paired `tool-call` / `tool-result` messages. Then it asserts
 * the four rules the plugin's design is staked on:
 *
 * 1. **Σ is injected before the recent window**, carrying the collapsed span and the
 *    seeded floor.
 * 2. **The superseded prefix is collapsed**, so the outbound payload is one head, one Σ
 *    message and the kept recent window — and nothing else.
 * 3. **No call/result pair is ever split**: every `tool-call` in the payload is still
 *    followed by its own `tool-result`, by id and in order.
 * 4. **The transform is idempotent**: running it twice on the same event yields the
 *    identical payload. This is the assertion that proves the durable transcript was
 *    never touched — a pass is a pure function of the raw transcript and Σ, so the same
 *    input gives the same bytes.
 *
 * It also unit-tests `merge` (⊕): a `null` deletes a key, a key the schema does not own
 * is dropped, dictionaries merge and arrays replace wholesale.
 *
 * Measure, don't deduce: every number below is printed, so a failure names the payload
 * that broke rather than a rule nobody can read.
 *
 * Run: `node scripts/smoke.mjs .` from the repo root.
 */

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// The fake Pi host is shared with the fixture capture, so the double this file
// asserts against is the double the golden-pi fixture was recorded through.
import { createPiHost, loadPiFactory, piContextEvent } from "./pi-host.mjs"

const root = resolve(process.argv[2] ?? ".")
const load = async (relative) => import(pathToFileURL(resolve(root, relative)).href)

/**
 * The user-level config path is redirected before the plugin is loaded.
 *
 * The plugin writes that file when it is missing, and this test must never touch a
 * real home: `MEGA_SKILLSTATE_CONFIG` points it at a scratch path, and the
 * whole run cleans up after itself.
 */
const scratchHome = mkdtempSync(join(tmpdir(), "mega-skillstate-config-"))
process.env.MEGA_SKILLSTATE_CONFIG = join(scratchHome, "mega-skillstate.json")

/** The options the smoke runs with, spelled out so the arithmetic below is pinned. */
const OPTIONS = { keepRecentTurns: 4, min: 4, staleAfter: 8 }

/** The routed model, and the window the model seam hands the plugin. */
const MODEL = { providerID: "opencode-go", id: "step-5-preview-free" }
const WINDOW = 128000

/** Deterministic filler, so every number in this file is reproducible. */
function filler(tag, size) {
  let out = tag + " "
  while (out.length < size) {
    out += "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor "
  }
  return out.slice(0, size)
}

/**
 * A synthetic transcript: a head instruction, then `turns` turns of
 * user / assistant / tool, each with one correctly paired call and result.
 */
function buildTranscript(turns = 20) {
  const messages = [
    { id: "u_head", role: "user", content: [{ type: "text", text: filler("the assignment", 900) }] },
  ]
  for (let turn = 1; turn <= turns; turn += 1) {
    const call = "call_" + turn
    messages.push({
      id: "u_" + turn,
      role: "user",
      content: [{ type: "text", text: filler("turn " + turn + " instruction", 220) }],
    })
    messages.push({
      id: "a_" + turn,
      role: "assistant",
      content: [
        { type: "reasoning", text: filler("reasoning for turn " + turn, 320) },
        { type: "tool-call", id: call, name: "read", input: { file_path: "src/file" + turn + ".ts", limit: 200 } },
      ],
    })
    messages.push({
      id: "r_" + turn,
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: call,
          name: "read",
          result: { type: "text", value: filler("result of turn " + turn, 2400) },
        },
      ],
    })
  }
  return messages
}

/** A `context` event, as the host builds one. */
function buildEvent(messages) {
  return { sessionID: "ses_smoke", agent: "build", model: MODEL, system: [], messages, tools: {} }
}

/**
 * A fake `ctx.storage`: a Map, with the real boundary semantics.
 *
 * Values cross it as copies, exactly as they cross the host's JSON store, so nothing in
 * memory is aliased to what the store holds — which is what makes the restart test below
 * a real restart instead of the same object read twice.
 */
function createStorage() {
  const map = new Map()
  const calls = { gets: [], sets: [] }
  return {
    map,
    calls,
    domain: {
      get: async (key) => {
        calls.gets.push(key)
        return map.has(key) ? structuredClone(map.get(key)) : undefined
      },
      set: async (key, value) => {
        calls.sets.push(key)
        map.set(key, structuredClone(value))
      },
      remove: async (key) => {
        map.delete(key)
      },
      scan: async () => ({}),
    },
  }
}

/**
 * A fake host that records what the plugin registered.
 *
 * @param options.storage - `false` for a host with no storage seam at all; `"broken"` for
 *   one whose store refuses every call, which is the degradation the plugin must survive.
 */
function createHost(options = {}) {
  const contextHooks = []
  const compactionHooks = []
  const tools = []
  const commands = []
  const prompts = []
  const registration = { dispose: async () => {} }
  const storage = options.storage === false || options.storage === "broken" ? undefined : createStorage()
  const domain =
    options.storage === "broken"
      ? {
          get: async () => {
            throw new Error("the store is down")
          },
          set: async () => {
            throw new Error("the store is down")
          },
        }
      : storage !== undefined
        ? storage.domain
        : undefined
  return {
    tools,
    commands,
    prompts,
    contextHooks,
    compactionHooks,
    storage,
    context: {
      location: { directory: root },
      options: OPTIONS,
      session: {
        hook: async (name, callback) => {
          if (name === "context") contextHooks.push(callback)
          else if (name === "compaction") compactionHooks.push(callback)
          else throw new Error("this plugin registers no " + name + " hook")
          return registration
        },
        get: async ({ sessionID }) => ({ id: sessionID }),
        context: async () => [],
        prompt: async (input) => {
          prompts.push(input)
        },
        compact: async (input) => {
          prompts.push(input)
        },
      },
      tool: {
        transform: async (callback) => {
          callback({ add: (definition) => tools.push(definition) })
          return registration
        },
        list: async () => tools.map((tool) => ({ name: tool.name })),
      },
      command: {
        transform: async (callback) => {
          callback({ add: (definition) => commands.push(definition) })
          return registration
        },
      },
      model: {
        transform: async (callback) => {
          callback({ list: () => [{ id: MODEL.id, providerID: MODEL.providerID, limit: { context: WINDOW } }] })
          return registration
        },
      },
      storage: domain,
    },
  }
}

/** Every call still has its own result, in order, with nothing orphaned either way. */
function checkPairing(messages, label) {
  const open = new Set()
  let calls = 0
  let results = 0
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === "tool-call") {
        assert.ok(!open.has(part.id), label + ": call " + part.id + " appears twice")
        open.add(part.id)
        calls += 1
      } else if (part.type === "tool-result") {
        assert.ok(open.has(part.id), label + ": result " + part.id + " has no call before it — the pair is split")
        open.delete(part.id)
        results += 1
      }
    }
  }
  assert.equal(open.size, 0, label + ": " + open.size + " call(s) left without a result")
  assert.equal(calls, results, label + ": " + calls + " call(s) and " + results + " result(s)")
  return calls
}

/** The rows one report line prints, so the numbers are stated the same way each time. */
function row(label, value) {
  console.log("  " + label.padEnd(34, ".") + " " + value)
}

console.log("mega-skillstate smoke — " + root + "\n")

// ---------------------------------------------------------------------------
// Load the plugin the way the host does, and register it against the fake host.
// ---------------------------------------------------------------------------
const plugin = await load("server.ts")
assert.equal(typeof plugin.default, "object", "server.ts must export a default plugin")
assert.equal(plugin.default.id, "mega-skillstate")
assert.equal(typeof plugin.default.setup, "function", "the plugin must export setup")

const host = createHost()
const dispose = await plugin.default.setup(host.context)
assert.equal(typeof dispose, "function", "setup must hand back a disposer")
assert.equal(host.contextHooks.length, 1, "one context hook")
assert.equal(host.compactionHooks.length, 1, "one compaction hook")
assert.equal(host.tools.length, 1, "one tool")
assert.equal(host.tools[0].name, "skill_state")
assert.equal(host.commands.length, 1, "one command")
assert.equal(host.commands[0].name, "skillstate")
assert.ok(host.tools[0].output, "the tool declares an output schema, or the host loses its result")
assert.ok(host.context.storage, "the host's storage seam is wired into the plugin")
console.log("registered: 1 context hook, 1 compaction hook, 1 tool (skill_state), 1 command (/skillstate)\n")

/** The store module, so the restart test can drop the in-memory tier and keep the rest. */
const state = await load("src/core/state.ts")

// ---------------------------------------------------------------------------
// The transform.
// ---------------------------------------------------------------------------
const messages = buildTranscript(20)
const rawCalls = checkPairing(messages, "the raw transcript")
const event = buildEvent(messages)
const transform = host.contextHooks[0]

const report = await transform(event)
assert.ok(report !== undefined, "the hook returns its report")

const stateMessage = messages[1]
assert.ok(stateMessage !== undefined, "Σ must be injected")
assert.equal(stateMessage.id, "mega_state", "Σ carries the injected id prefix")
assert.equal(stateMessage.role, "user")
const stateText = stateMessage.content[0].text
assert.ok(stateText.startsWith("<skill-state>"), "Σ is wrapped and labelled")
assert.ok(stateText.includes("turns 2-17"), "Σ names the span it replaced, got: " + stateText.slice(0, 200))
const stateJson = JSON.parse(stateText.slice(stateText.indexOf("{"), stateText.lastIndexOf("}") + 1))
row("Σ keys", Object.keys(stateJson).join(", "))

// (a) Σ sits before the recent window, and the protected head is still first.
assert.equal(messages[0].id, "u_head", "the first instruction is protected")
assert.equal(messages.indexOf(stateMessage), 1, "Σ is injected immediately after the head")
const keptRecent = OPTIONS.keepRecentTurns * 3
assert.equal(messages.length - 2, keptRecent, "exactly the recent window follows Σ")

// (b) The superseded prefix is collapsed.
const expectedLength = 1 + 1 + keptRecent
assert.equal(
  messages.length,
  expectedLength,
  "the payload is 1 head + 1 Σ + " + keptRecent + " recent message(s), got " + messages.length,
)
assert.equal(
  report.collapsed.messages,
  48,
  "the collapse replaced the whole superseded prefix",
)
assert.equal(report.collapsed.from, 2)
assert.equal(report.collapsed.to, 17)

// (c) No pair is split, and what survived is the window that should have survived.
const keptCalls = checkPairing(messages, "the collapsed payload")
assert.equal(keptCalls, OPTIONS.keepRecentTurns, "one call per kept turn")
const keptCallNumbers = []
for (const message of messages) {
  for (const part of message.content ?? []) {
    if (part.type !== "tool-call") continue
    keptCallNumbers.push(Number(part.id.slice("call_".length)))
  }
}
// The newest four head-turns are 18..21, and head-turn 18 is the user message that opens
// synthetic turn 17 — so exactly the calls of synthetic turns 17..20 survive.
assert.deepEqual(keptCallNumbers, [17, 18, 19, 20], "only the recent window's calls survive")

row("raw transcript", rawCalls + " paired call(s), " + (1 + 20 * 3) + " messages")
row("Σ injected", "messages[1], " + stateMessage.id)
row("collapsed span", "turns " + report.collapsed.from + "-" + report.collapsed.to + " (" + report.collapsed.messages + " messages)")
row("recent window kept", OPTIONS.keepRecentTurns + " turn(s), " + keptRecent + " messages")
row("outbound messages", rawCalls === 20 ? (1 + 20 * 3) + " -> " + messages.length : messages.length)
row("measured context", report.tokensBefore + " -> " + report.tokensAfter + " tokens (window " + (report.window ?? "unknown") + ")")
row("saved", report.tokensBefore - report.tokensAfter + " tokens, " + Math.round(((report.tokensBefore - report.tokensAfter) / report.tokensBefore) * 100) + "% of the payload")
assert.ok(report.tokensAfter < report.tokensBefore, "the collapse must reduce the payload")
assert.ok(report.tokensAfter > 0)
row("steps since user", report.stepsSinceUser)
row("notes", report.notes.length === 0 ? "(none)" : report.notes.join(" | "))
console.log("")

// ---------------------------------------------------------------------------
// Idempotence: the same conversation must give the same bytes, twice.
// ---------------------------------------------------------------------------
const afterFirst = JSON.stringify(messages)
const systemAfterFirst = JSON.stringify(event.system)
const second = await transform(event)
assert.equal(JSON.stringify(messages), afterFirst, "running the transform twice must yield the identical payload")
assert.equal(JSON.stringify(event.system), systemAfterFirst, "the standing policy is pushed once")
assert.equal(second.tokensAfter, report.tokensAfter, "and the same measurement")
row("idempotence", "two passes, byte-identical payloads")
assert.ok(event.system.some((part) => part.text.length > 0), "the standing policy is in the system parts")
assert.ok(event.tools["skill_state"] !== undefined, "the tool is offered on the wire")
assert.deepEqual(Object.keys(event.tools), ["skill_state"])
console.log("")

// ---------------------------------------------------------------------------
// ⊕: the merge operator.
// ---------------------------------------------------------------------------
const schema = await load("src/core/schema.ts")
const deleted = schema.merge({ objective: "ship the plugin", done: ["one", "two"] }, { done: null })
assert.deepEqual(deleted, { objective: "ship the plugin" }, "a null deletes the key")

const unknown = schema.merge({}, { not_a_key: 1, objective: "bound the window" })
assert.deepEqual(unknown, { objective: "bound the window" }, "a key the schema does not own is dropped")
assert.deepEqual(schema.unknownKeys({ not_a_key: 1, objective: "x" }), ["not_a_key"])

const nested = schema.merge(
  { files: { "a.ts": "read", "b.ts": "edited" } },
  { files: { "b.ts": null, "c.ts": "written" } },
)
assert.deepEqual(nested, { files: { "a.ts": "read", "c.ts": "written" } }, "dictionaries merge, and null deletes inside one")

// The accumulated logs are maps for exactly that reason: a decision or a finding written
// today must merge rather than replace, so yesterday's entry survives a patch that does
// not mention it. `plan` is the opposite case — the current plan *is* the newest list.
const logs = schema.merge(
  { findings: { "first finding": "one line" }, decisions: { "bootstrap": "write the defaults" } },
  { findings: { "second finding": "one line" }, decisions: { "precedence": "layered" } },
)
assert.deepEqual(logs.findings, { "first finding": "one line", "second finding": "one line" }, "findings merge key by key")
assert.equal(Object.keys(logs.decisions).length, 2, "and so do decisions")

const listed = schema.merge({ plan: [{ step: "a", status: "todo" }] }, { plan: [{ step: "b", status: "todo" }] })
assert.equal(listed.plan.length, 1, "an array replaces wholesale")
assert.equal(listed.plan[0].step, "b")

const untouched = schema.merge({ objective: "keep" }, "not an object")
assert.deepEqual(untouched, { objective: "keep" }, "a patch that is not an object changes nothing")

// Rendering is stable, because the injected message must be the same bytes every pass.
const alpha = schema.render({ files: { "b.ts": "read", "a.ts": "read" }, objective: "x" })
const beta = schema.render({ objective: "x", files: { "a.ts": "read", "b.ts": "read" } })
assert.equal(alpha, beta, "the same Σ renders the same bytes whatever order it was written in")

row("merge", "null deletes, unknown keys dropped, arrays replace, log maps merge")
row("render", "stable key order, " + alpha.length + " chars")
console.log("")

// ---------------------------------------------------------------------------
// The write channel: `skill_state` applies the patch and says what changed.
// ---------------------------------------------------------------------------
const tool = host.tools[0]
const ack = await tool.execute(
  {
    state_patch: { objective: "bound the window", findings: { "Σ is the record": "a fact Σ carries" }, not_a_key: 3 },
    summary: "first write",
  },
  { sessionID: "ses_smoke", agent: "build", messageID: "msg_1", id: "call_state", signal: new AbortController().signal },
)
const ackText = typeof ack.content === "string" ? ack.content : ack.content.map((part) => part.text).join("\n")
// The counter continues from what Σ already carried — the seed put 4 there — rather than
// restarting, because the step index is a key of Σ and not a private tally.
assert.ok(ackText.startsWith("skill-state updated → step " + (stateJson.step + 1) + " (changed: "), ackText)
assert.ok(ackText.includes("objective"), ackText)
assert.ok(ackText.includes("step"), ackText)
assert.ok(ackText.includes("dropped (not in the schema): not_a_key"), ackText)
assert.equal(ack.output.kind, "state")
assert.equal(ack.output.step, stateJson.step + 1)
assert.equal(ack.output.summary, "first write")
row("skill_state ack", ackText.replace(/\n/g, " · "))

// A tool write is durable: the store holds what the model committed, keyed by session.
const persisted = host.storage.map.get("state/ses_smoke")
assert.ok(persisted !== undefined, "a state write reaches the durable store")
assert.equal(persisted.state.objective, "bound the window")
assert.deepEqual(persisted.state.findings, { "Σ is the record": "a fact Σ carries" })
assert.ok(host.storage.calls.sets.includes("state/ses_smoke"), "the write went through storage.set")
assert.deepEqual(persisted.collapsed, { from: 2, to: 17 }, "the committed span is durable too")
row("durable write", "state/ses_smoke persisted " + Object.keys(persisted.state).join(", "))

// The patch's tolerant read: the input schema admits an object or a JSON string, because
// the host validates the call before `execute` runs — a quoted patch refused there is
// never seen again, while a string let through can still be decoded. A bare string and a
// fenced one both write; a string that is not a JSON object refuses with Σ untouched.
// A session of its own, so the counts the command section asserts on stay put.
assert.deepEqual(tool.input.properties.state_patch.type, ["object", "string"], "the host's gate admits both forms")

const stringsCtx = (messageID, id) => ({
  sessionID: "ses_smoke_strings",
  agent: "build",
  messageID,
  id,
  signal: new AbortController().signal,
})
const stringPatch = await tool.execute(
  {
    state_patch: JSON.stringify({
      objective: "written through a string patch",
      decisions: { "string form": "parsed by the runtime" },
      not_a_key: 5,
    }),
  },
  stringsCtx("msg_2", "call_state_string"),
)
const stringAck = typeof stringPatch.content === "string" ? stringPatch.content : stringPatch.content.map((part) => part.text).join("\n")
assert.equal(stringPatch.output.kind, "state", stringAck)
assert.ok(stringAck.includes("arrived as a JSON string"), stringAck)
assert.deepEqual(stringPatch.output.dropped, ["not_a_key"], "unknown keys inside a string patch are dropped like any other")
const afterString = host.storage.map.get("state/ses_smoke_strings")
assert.equal(afterString.state.objective, "written through a string patch")
assert.equal(afterString.state.decisions["string form"], "parsed by the runtime", "a string patch merges like an object")
row("state_patch as string", stringAck.replace(/\n/g, " · "))

const fenced = await tool.execute(
  { state_patch: "```json\n" + JSON.stringify({ objective: "fenced, then decoded" }) + "\n```" },
  stringsCtx("msg_3", "call_state_fenced"),
)
assert.equal(fenced.output.kind, "state")
assert.equal(fenced.output.step, stringPatch.output.step + 1, "the counter moves like any other write")
assert.equal(host.storage.map.get("state/ses_smoke_strings").state.objective, "fenced, then decoded", "a fenced string is decoded behind the fence")
row("state_patch fenced", "```json block decoded")

const broken = await tool.execute({ state_patch: "{not json" }, stringsCtx("msg_4", "call_state_broken"))
const brokenAck = typeof broken.content === "string" ? broken.content : broken.content.map((part) => part.text).join("\n")
assert.equal(broken.output.kind, "error", brokenAck)
assert.ok(brokenAck.includes("not valid JSON"), brokenAck)

const notObject = await tool.execute({ state_patch: "[1, 2]" }, stringsCtx("msg_5", "call_state_not_object"))
const notObjectAck = typeof notObject.content === "string" ? notObject.content : notObject.content.map((part) => part.text).join("\n")
assert.equal(notObject.output.kind, "error", notObjectAck)
assert.ok(notObjectAck.includes("decoded to an array"), notObjectAck)
const afterRefusals = host.storage.map.get("state/ses_smoke_strings")
assert.equal(afterRefusals.state.objective, "fenced, then decoded", "a refusal writes nothing")
assert.equal(afterRefusals.state.step, fenced.output.step, "and does not move the step")
row("state_patch refusals", "broken string and non-object string leave Σ alone")

// ---------------------------------------------------------------------------
// The guards: the collapse is conservative by default, and a subagent keeps its own.
// ---------------------------------------------------------------------------
function hostWith(options, overrides = {}, storageMode = true) {
  const made = createHost({ storage: storageMode })
  made.context.options = options
  if (overrides.parentID !== undefined) {
    made.context.session.get = async ({ sessionID }) => ({ id: sessionID, parentID: overrides.parentID })
  }
  return made
}

const off = hostWith({ keepRecentTurns: 4, min: 4, collapseOlder: false })
await plugin.default.setup(off.context)
const offEvent = buildEvent(buildTranscript(20))
await off.contextHooks[0](offEvent)
assert.equal(
  offEvent.messages.some((message) => message.id === "mega_state"),
  false,
  "collapseOlder: false leaves the transcript whole",
)
assert.equal(offEvent.messages.length, 61, "collapseOlder: false changes nothing")
row("collapseOlder: false", "61 messages, no Σ injected")

const child = hostWith({ keepRecentTurns: 4, min: 4 }, { parentID: "ses_parent" })
await plugin.default.setup(child.context)
const childEvent = buildEvent(buildTranscript(20))
await child.contextHooks[0](childEvent)
assert.equal(childEvent.messages.length, 61, "a subagent session is left alone")
assert.equal(childEvent.messages.some((message) => message.id === "mega_state"), false)
row("subagent session", "left whole (allowSubagentSessions is off)")
console.log("")

// ---------------------------------------------------------------------------
// The stale reminder, and that it only ever lands at a balanced tail.
//
// A fresh session and a fresh event, because the earlier phases of this file have
// already taken their own steps and `stepsSinceUser` is a session's running count.
// ---------------------------------------------------------------------------
const reminderEvent = buildEvent(buildTranscript(20))
const reminderSession = "ses_smoke_reminder"
reminderEvent.sessionID = reminderSession
const reminderHook = host.contextHooks[0]
for (let pass = 0; pass < OPTIONS.staleAfter; pass += 1) {
  const quiet = await reminderHook(reminderEvent)
  assert.equal(quiet.nudged, false, "no reminder before " + OPTIONS.staleAfter + " steps")
}
const stale = await reminderHook(reminderEvent)
assert.equal(stale.nudged, true, "a reminder once the state has gone stale")
assert.equal(stale.stepsSinceUser, OPTIONS.staleAfter)
const reminder = reminderEvent.messages[reminderEvent.messages.length - 1]
assert.equal(reminder.id, "mega_notice_stale")
assert.ok(reminder.content[0].text.includes("<skill-state>"))
checkPairing(reminderEvent.messages, "the payload with a reminder")
const again = await reminderHook(reminderEvent)
// The reminder is stripped and rewritten every pass, because it is a derived message
// like every other one this plugin mints: what has to be stable is the *payload*, not
// the identity of the message.
assert.equal(again.nudged, true, "the reminder is rewritten, not duplicated")
assert.equal(again.tokensAfter, stale.tokensAfter, "and the payload did not move")
checkPairing(reminderEvent.messages, "the payload after a second reminder pass")
row("stale reminder", "appended after " + OPTIONS.staleAfter + " steps, at a balanced tail")

// ---------------------------------------------------------------------------
// The command: it measures the same payload, and `now` is a forced pass on demand.
// ---------------------------------------------------------------------------
await host.commands[0].execute({ sessionID: "ses_smoke", prompt: {} })
assert.equal(host.prompts.length, 1, "/skillstate replies once")
const printed = host.prompts[0].text
assert.ok(printed.includes("Σ (step 5"), printed)
assert.ok(printed.includes("collapsed into Σ"), printed)
assert.ok(printed.includes("turn 21"), printed)
row("/skillstate", "printed Σ, the context and the per-turn index")

await host.commands[0].execute({ sessionID: "ses_smoke", prompt: { text: "now" } })
assert.equal(host.prompts.length, 2, "`now` replies once")
const forced = host.prompts[1].text
assert.ok(forced.includes("Σ already stands for turns 2-17"), forced)
checkPairing(messages, "the payload after /skillstate now")
row("/skillstate now", "forced a pass, left the pairs intact")

// ---------------------------------------------------------------------------
// The compaction seam: Σ handed back instead of the host's own summary request.
// ---------------------------------------------------------------------------
const compactionMessages = buildTranscript(6)
const compactionEvent = {
  sessionID: "ses_compaction",
  agent: "build",
  model: MODEL,
  system: [],
  tools: {},
  messages: compactionMessages,
}
// Before the collapse, the model commits its own account of one file. The compaction
// sweep then reads a transcript whose tool calls touch a different file, and must not
// overwrite what the model said: a seed fills holes only.
await host.tools[0].execute(
  {
    state_patch: { files: { "src/model-said.md": "the model's own account of this file" } },
  },
  {
    sessionID: "ses_compaction",
    agent: "build",
    messageID: "msg_c1",
    id: "call_c1",
    signal: new AbortController().signal,
  },
)
// A context pass first, so this session has actually collapsed a span: the compaction
// summary must carry the persisted span, not a fresh guess about it.
const compactionCollapse = await transform(compactionEvent)
assert.equal(compactionCollapse.collapsed.from, 2, "turns 2-3 are superseded")
assert.equal(compactionCollapse.collapsed.to, 3)
assert.equal(compactionCollapse.collapsed.messages, 6)
const persistedSpan = host.storage.map.get("state/ses_compaction").collapsed
assert.deepEqual(persistedSpan, { from: 2, to: 3 }, "the committed span is durable")

// The host rebuilds the transcript for the compaction request, exactly as it does for a
// context one. Σ is served from the in-memory LRU here, so the durable read is proven by
// the restart section below; what this pass must show is that the *persisted* span comes
// back rather than a fresh guess about it.
const modelCallsBefore = host.prompts.length
const compactionRebuilt = {
  sessionID: "ses_compaction",
  agent: "build",
  model: MODEL,
  system: [],
  tools: {},
  messages: buildTranscript(6),
}
const compaction = await host.compactionHooks[0](compactionRebuilt)
assert.equal(compaction.owned, true, "the distilled Σ was worth handing back")
assert.equal(compaction.collapsed.from, 2, "and it carries the span it committed")
assert.equal(compaction.collapsed.to, 3)
assert.equal(
  host.prompts.length,
  modelCallsBefore,
  "owning the compaction means no model call at all — that is the whole point",
)
assert.ok(compactionRebuilt.result !== undefined, "result is set when Σ has something to say")
assert.equal(typeof compactionRebuilt.result.summary, "string")
const summary = compactionRebuilt.result.summary
assert.ok(summary.startsWith("<skill-state>"), summary.slice(0, 120))
assert.ok(summary.includes("Collapsed: turns 2-3"), summary.slice(0, 400))
assert.ok(summary.includes("the model's own account of this file"), "the model-authored files entry survives")
assert.ok(
  !summary.includes('"src/file1.ts"'),
  "and the seed sweep did not clobber it with what the transcript touched",
)
// The transcript is read, never written.
assert.equal(compactionRebuilt.messages.length, 1 + 6 * 3, "and must not touch the messages it read")
assert.equal(compactionRebuilt.messages[0].id, "u_head")
checkPairing(compactionRebuilt.messages, "the transcript a compaction hook read")
assert.ok(
  host.storage.calls.sets.filter((key) => key === "state/ses_compaction").length > 0,
  "the seed sweep persists what it filled",
)
row("compaction", "owned the summary from Σ, no model call, transcript untouched")

// The guard: an empty Σ leaves `result` unset so the host summarises in its own way.
const emptyEvent = {
  sessionID: "ses_compaction_empty",
  agent: "build",
  model: MODEL,
  system: [],
  tools: {},
  messages: [],
}
const emptyReport = await host.compactionHooks[0](emptyEvent)
assert.equal(emptyReport.owned, false, "nothing to say")
assert.equal(emptyEvent.result, undefined, "an empty Σ leaves the host its own summarizer")
row("compaction guard", "empty Σ → result unset, host summarises")
console.log("")

// ---------------------------------------------------------------------------
// A restart: the in-memory tier is dropped, the durable store survives.
// ---------------------------------------------------------------------------
const restartEvent = buildEvent(buildTranscript(20))
restartEvent.sessionID = "ses_restart"
await host.tools[0].execute(
  {
    state_patch: {
      objective: "bound the window",
      findings: { "Σ outlives the process": "the durable store survives a restart" },
      done: ["the wrapper module"],
    },
  },
  { sessionID: "ses_restart", agent: "build", messageID: "msg_r", id: "call_r", signal: new AbortController().signal },
)
const restartFirst = await transform(restartEvent)
assert.ok(restartFirst.collapsed !== undefined, "the first pass collapses")
const beforeRestart = restartEvent.messages[1].content[0].text
assert.ok(beforeRestart.includes("bound the window"), "the model's own Σ is in the payload")
assert.ok(beforeRestart.includes("Σ outlives the process"))
const restartedKeys = new Set(Object.keys(JSON.parse(beforeRestart.slice(beforeRestart.indexOf("{"), beforeRestart.lastIndexOf("}") + 1))))
row("Σ before restart", [...restartedKeys].join(", "))

// The whole in-memory tier goes; the store does not.
assert.ok(state.stateCount() > 1, "sessions were held in memory")
state.resetStateStore()
assert.equal(state.stateCount(), 0, "the in-memory map is empty — the process restarted")
const storeOnly = host.storage.map.get("state/ses_restart")
assert.ok(storeOnly !== undefined, "the durable store still holds it")
assert.equal(storeOnly.state.objective, "bound the window")

const readsBefore = host.storage.calls.gets.filter((key) => key === "state/ses_restart").length
const restartSecond = await transform(restartEvent)
assert.ok(
  host.storage.calls.gets.filter((key) => key === "state/ses_restart").length > readsBefore,
  "the restarted process re-read the durable store",
)
assert.equal(restartSecond.collapsed.messages, 0, "a second pass has nothing fresh to collapse")
const afterRestart = restartEvent.messages[1].content[0].text
assert.ok(afterRestart.includes("bound the window"), "Σ survived the restart")
assert.ok(afterRestart.includes("Σ outlives the process"), "...and so did the findings")
assert.ok(afterRestart.includes("the wrapper module"), "...and so did what the model said was done")
checkPairing(restartEvent.messages, "the payload after a restart")
row("restart", "in-memory dropped, Σ re-read from storage, model keys intact")

// And the compaction path reads the same way: the persisted span and the model's own keys
// come back from the store, with no memory tier to serve them. The transform above put
// the session back in the LRU, so the tier is dropped once more immediately before.
state.resetStateStore()
const compactionReads = host.storage.calls.gets.filter((key) => key === "state/ses_restart").length
const compactionAfterRestart = await host.compactionHooks[0]({
  sessionID: "ses_restart",
  agent: "build",
  model: MODEL,
  system: [],
  tools: {},
  messages: buildTranscript(6),
})
assert.ok(
  host.storage.calls.gets.filter((key) => key === "state/ses_restart").length > compactionReads,
  "the compaction pass after a restart reads the durable store",
)
assert.equal(compactionAfterRestart.owned, true, "and still has something worth saying")
assert.ok(
  compactionAfterRestart.notes.every((note) => !/could not be read/.test(note)),
  "with no store failure to report",
)
checkPairing(restartEvent.messages, "the transcript after a restarted compaction")
row("compaction after restart", "persisted Σ and span re-read from storage")

// ---------------------------------------------------------------------------
// Degradation: a host with no store, and a host whose store refuses everything.
// ---------------------------------------------------------------------------
const noStore = hostWith({ keepRecentTurns: 4, min: 4 }, undefined, false)
await plugin.default.setup(noStore.context)
const noStoreEvent = buildEvent(buildTranscript(20))
await noStore.contextHooks[0](noStoreEvent)
assert.equal(noStoreEvent.messages.length, 14, "a host with no storage seam still collapses")
assert.equal(noStoreEvent.messages[1].id, "mega_state")
checkPairing(noStoreEvent.messages, "the payload on a host with no store")
row("no storage seam", "in-memory only, the collapse is unchanged")

const brokenStore = hostWith({ keepRecentTurns: 4, min: 4, debug: true }, undefined, "broken")
await plugin.default.setup(brokenStore.context)
// Capture what the plugin logs, so the degradation is proven rather than assumed: a
// store that refuses must be *reported*, never thrown, and never silently swallowed.
const logged = []
const realError = console.error
console.error = (line) => logged.push(String(line))
const brokenEvent = buildEvent(buildTranscript(20))
brokenEvent.sessionID = "ses_broken"
const brokenReport = await brokenStore.contextHooks[0](brokenEvent)
console.error = realError
assert.equal(brokenReport.turns, 21, "the pass measured the whole transcript anyway")
assert.ok(
  logged.some((line) => line.includes("the durable store could not be read for ses_broken")),
  "the refused read was reported: " + JSON.stringify(logged),
)
assert.ok(logged.some((line) => line.includes("refused state/ses_broken")), "and so was the refused write")
assert.equal(brokenEvent.messages.length, 14, "a store that refuses everything still collapses")
assert.equal(brokenEvent.messages[1].id, "mega_state", "and Σ is still injected")
assert.deepEqual(brokenReport.notes, [], "and no failure escapes into the request's account")
checkPairing(brokenEvent.messages, "the payload on a host with a broken store")
row("broken store", "degraded to in-memory, reported, never threw")
console.log("")

// ---------------------------------------------------------------------------
// The installer: copy, idempotence on bytes, named drift, and the legacy link.
//
// `scripts/install.ts` runs against a scratch directory, never against the real
// discovery dirs, so the smoke test can prove the destructive case without being
// destructive. What is pinned here: an install is a real directory holding exactly
// the shipped set — the manifest's `files[]` plus `package.json` itself, without
// which the copy cannot load as ESM; a copy that matches byte for byte is left
// alone; a drifted copy is synced, and driftReport *names* what differed; and a
// junction left from before the copy switch is replaced without recursion,
// because recursing follows the link and deletes the *target's* contents.
// ---------------------------------------------------------------------------
{
  const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } =
    await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")

  const install = await import("./install.ts")
  const scratch = mkdtempSync(join(tmpdir(), "mega-skillstate-install-"))
  const plugins = join(scratch, "plugins")

  // A package root that looks enough like one: the loader's entry has to exist,
  // and the manifest is where both the discovery-directory name and the shipped
  // set are read from. The installer derives the copy's name rather than carrying
  // a fourth literal for it, so a fake root without a manifest is no package root.
  const fakeRoot = join(scratch, "package")
  mkdirSync(fakeRoot, { recursive: true })
  const manifestName = "mega-skillstate"
  writeFileSync(join(fakeRoot, "server.ts"), "// a stand-in for the host entry\n")
  writeFileSync(
    join(fakeRoot, "package.json"),
    JSON.stringify({ name: manifestName, files: ["server.ts", "keep.txt"] }) + "\n",
  )
  writeFileSync(join(fakeRoot, "keep.txt"), "the target's own content\n")
  const copyPath = join(plugins, manifestName)

  try {
    // (a) The install is a real directory, holding exactly the shipped set.
    // package.json is in the copy even though the fake manifest's files[] omits
    // it, and that is the pin that matters: "type": "module" is what makes the
    // host load the .ts as ESM, and a copy without its manifest fails to load.
    const first = install.installInto(plugins, fakeRoot, "user")
    assert.equal(first.action, "installed", "the first install writes a copy")
    assert.equal(first.scope, "user", "and the scope is propagated, not hardcoded")
    assert.ok(existsSync(copyPath), "the copy exists on disk")
    assert.ok(!lstatSync(copyPath).isSymbolicLink(), "and it is a real directory, not a link")
    for (const shipped of ["server.ts", "package.json", "keep.txt"]) {
      assert.ok(existsSync(join(copyPath, shipped)), "the copy carries " + shipped)
    }
    assert.deepEqual(
      install.shippableFiles(fakeRoot),
      ["server.ts", "keep.txt", "package.json"],
      "the shipped set is files[] plus package.json itself",
    )
    assert.deepEqual(
      install.driftReport(copyPath, fakeRoot),
      { missing: [], changed: [], extra: [] },
      "a fresh copy does not drift",
    )

    // (b) Idempotence is measured on bytes: an in-sync copy is left alone, never
    // rewritten, so a reinstall is not a churn of mtimes.
    const second = install.installInto(plugins, fakeRoot, "user")
    assert.equal(second.action, "current", "a second install is a no-op")
    assert.equal(second.changed, 0, "and it writes nothing")

    // (c) Drift is named, then synced: a reinstall is an upgrade. Each of the
    // three failure modes — a file edited in place, a file deleted, a file the
    // repository never shipped — is reported before it is repaired.
    writeFileSync(join(copyPath, "keep.txt"), "edited in place, like a stale copy\n")
    assert.deepEqual(install.driftReport(copyPath, fakeRoot).changed, ["keep.txt"], "an edited file is changed")
    rmSync(join(copyPath, "server.ts"))
    assert.deepEqual(
      install.driftReport(copyPath, fakeRoot).missing,
      ["server.ts"],
      "a deleted file is missing",
    )
    writeFileSync(join(copyPath, "stray.txt"), "not in the shipped set\n")
    assert.deepEqual(install.driftReport(copyPath, fakeRoot).extra, ["stray.txt"], "an unshipped file is extra")
    const repaired = install.installInto(plugins, fakeRoot, "user")
    assert.equal(repaired.action, "updated", "a drifted copy is synced")
    assert.deepEqual(
      install.driftReport(copyPath, fakeRoot),
      { missing: [], changed: [], extra: [] },
      "the sync leaves no drift behind",
    )
    assert.equal(
      readFileSync(join(copyPath, "keep.txt"), "utf8"),
      "the target's own content\n",
      "and the sync restores the shipped bytes",
    )

    // (d) The destructive case, kept from the link era: a junction is removed
    // without recursion. Recursing follows the link and deletes the *target's*
    // contents — this repository, in production.
    const staleTarget = join(scratch, "stale")
    mkdirSync(staleTarget, { recursive: true })
    writeFileSync(join(staleTarget, "server.ts"), "// a deleted checkout's stand-in\n")
    writeFileSync(join(staleTarget, "keep.txt"), "the legacy target's own content\n")
    rmSync(copyPath, { recursive: true, force: true })
    symlinkSync(staleTarget, copyPath, "junction")
    const migrated = install.installInto(plugins, fakeRoot, "user")
    assert.equal(migrated.action, "replaced", "a legacy junction is replaced with a copy")
    assert.ok(!lstatSync(copyPath).isSymbolicLink(), "the junction is gone")
    assert.ok(existsSync(join(copyPath, "package.json")), "and the copy ships the manifest")
    assert.equal(existsSync(join(staleTarget, "keep.txt")), true, "the junction's target is left intact")

    // (e) Uninstall deletes a real directory, and a legacy link the same
    // cautious way. The repository the fake root stands in for survives both.
    install.uninstallFrom(plugins, fakeRoot, "user")
    assert.equal(existsSync(copyPath), false, "the copy is gone")
    assert.equal(existsSync(join(fakeRoot, "server.ts")), true, "so is not the repository itself")
    assert.equal(
      install.uninstallFrom(plugins, fakeRoot, "user").action,
      "missing",
      "a second removal has nothing to do",
    )
    symlinkSync(staleTarget, copyPath, "junction")
    assert.equal(
      install.uninstallFrom(plugins, fakeRoot, "project").action,
      "removed",
      "a legacy junction uninstalls too",
    )
    assert.equal(existsSync(join(staleTarget, "keep.txt")), true, "and still leaves the target alone")
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  row("install", "copied, idempotent on bytes, drift named and synced, junctions migrated")


  // Three modes, and the flag parser rejects anything it does not know.
  assert.deepEqual(
    install.parseArgs(["--project"]),
    { project: true, remove: false, status: false },
    "--project selects the project scope",
  )
  assert.deepEqual(
    install.parseArgs(["--remove"]),
    { project: false, remove: true, status: false },
    "--remove uninstalls",
  )
  assert.throws(() => install.parseArgs(["--instal"]), /unknown argument/, "a typo'd flag is refused, not ignored")
  row("install args", "three modes, an unknown flag is an error")
}

// ---------------------------------------------------------------------------
// The config surface: a user-level file written with the defaults, layered over
// the copy an install carries and under the host's own entry.
//
// Every path below is the redirected scratch one set before the plugin loaded,
// so the bootstrap write never reaches a real home; the directory is removed
// with the `scratchHome` cleanup at the end of this file.
// ---------------------------------------------------------------------------
{
  const config = await load("src/core/config.ts")
  const dir = mkdtempSync(join(tmpdir(), "mega-skillstate-config-"))
  const userFile = join(dir, "mega-skillstate.json")
  process.env.MEGA_SKILLSTATE_CONFIG = userFile

  // (a) A first run writes every default, pretty-printed — and a file that exists is
  // the user's own: it is never rewritten, edits included.
  assert.equal(existsSync(userFile), false, "the redirected file starts absent")
  await plugin.default.setup(createHost().context)
  assert.ok(existsSync(userFile), "setup writes the user-level file when it is missing")
  const written = readFileSync(userFile, "utf8")
  assert.deepEqual(JSON.parse(written), config.DEFAULT_CONFIG, "the file carries every default")
  assert.ok(written.endsWith("\n"), "and is newline-terminated")
  await plugin.default.setup(createHost().context)
  assert.equal(readFileSync(userFile, "utf8"), written, "an existing file is never rewritten")

  // (b) The user-level layer beats the copy the install carries: `options.json`
  // ships `keepRecentTurns: 4`, so a file that says 2 is what runs.
  writeFileSync(userFile, JSON.stringify({ keepRecentTurns: 2 }) + "\n", "utf8")
  const userLayer = hostWith({})
  await plugin.default.setup(userLayer.context)
  const userEvent = buildEvent(buildTranscript(20))
  await userLayer.contextHooks[0](userEvent)
  assert.equal(
    userEvent.messages.length,
    8,
    "the user file's keepRecentTurns: 2 wins over the shipped options.json, got " + userEvent.messages.length,
  )

  // (c) The host's entry is the most specific layer, so its value wins over the user file's.
  const hostLayer = hostWith({ keepRecentTurns: 5 })
  await plugin.default.setup(hostLayer.context)
  const hostEvent = buildEvent(buildTranscript(20))
  await hostLayer.contextHooks[0](hostEvent)
  assert.equal(
    hostEvent.messages.length,
    17,
    "the host entry's keepRecentTurns: 5 wins over the user file's 2, got " + hostEvent.messages.length,
  )

  // (d) A malformed user-level file is an error, like every other config mistake.
  writeFileSync(userFile, "{ not json", "utf8")
  await assert.rejects(
    async () => plugin.default.setup(createHost().context),
    /is not JSON/,
    "a user-level file that is not JSON refuses the load",
  )
  rmSync(dir, { recursive: true, force: true })

  // (e) The shipped-options path resolves to a file that exists, and the layer it
  // names is actually read. A wrong depth reads a missing file, and the merge
  // treats a missing layer as nothing at all, so the shipped `options.json`
  // would silently stop contributing. That is the defect the core extraction
  // carried through the move undetected — the shipped values equal the defaults,
  // and no row read the layer. This row is the pin that closes it.
  const adapter = await load("src/adapters/opencode/index.ts")
  assert.ok(
    existsSync(adapter.OPTIONS_PATH),
    "OPTIONS_PATH must point at a file that exists, got " + adapter.OPTIONS_PATH,
  )
  const shipped = config.resolveOptions({}, adapter.OPTIONS_PATH, undefined)
  assert.equal(
    shipped.keepRecentTurns,
    4,
    "the shipped options.json layer is read, got " + JSON.stringify(shipped),
  )

  row("user config", "written with the defaults when absent, never rewritten")
  row("config layers", "options.json < user file < host entry (window 2, then 5)")
  row("options path", "the shipped layer resolves, exists, and is read")
}

// ---------------------------------------------------------------------------
// The golden payloads: a byte-for-byte replay of the committed baseline.
//
// The rows above pin behavior by numbers and content, but a refactor can pass
// every one of them while quietly reshaping the payload — the same text in a
// different part shape, the same report under different keys. `fixtures/
// golden.json` is the byte-level baseline: `scripts/capture-golden.mjs`
// recorded it through this plugin's public surface — the host entry, a fake
// host, the real `context` and command hooks — before any module moved, and
// every case here is replayed through a fresh host and compared byte for byte.
//
// The file is test data and does not ship (`package.json` `files[]` is
// unchanged), so a copy installed from this package still runs: the row says so
// when the file is absent rather than failing. `npm run smoke` against the
// repository pins it.
// ---------------------------------------------------------------------------
{
  const goldenPath = join(root, "fixtures", "golden.json")
  if (!existsSync(goldenPath)) {
    row("golden payloads", "no fixtures/golden.json — run `node scripts/capture-golden.mjs .` to pin the baseline")
  } else {
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"))
    assert.equal(golden.schema, 1, "this smoke reads golden schema 1")

    /** The same cut of the report the capture recorded, so the diff is byte-level. */
    const cutReport = (report) => ({
      tokensBefore: report.tokensBefore,
      tokensAfter: report.tokensAfter,
      window: report.window ?? null,
      keepRecentTurns: report.keepRecentTurns,
      turns: report.turns,
      currentTurn: report.currentTurn,
      stepsSinceUser: report.stepsSinceUser,
      collapsed: report.collapsed ?? null,
      nudged: report.nudged,
      notes: [...report.notes],
    })

    /** The capture's storage modes, mapped onto this file's `createHost` vocabulary. */
    const storageModeFor = (mode) => (mode === "none" ? false : mode === "broken" ? "broken" : true)

    /** A `context` event carrying one case's own transcript and session id. */
    const caseEvent = (transcript, sessionID) => ({
      sessionID,
      agent: "build",
      model: MODEL,
      system: [],
      messages: transcript,
      tools: {},
    })

    // A scratch user-config path, so the cases run against the real layered
    // config exactly as the capture did: the defaults, the user file the first
    // setup writes, and the case's own host options on top.
    const goldenScratch = mkdtempSync(join(tmpdir(), "mega-skillstate-golden-"))
    process.env.MEGA_SKILLSTATE_CONFIG = join(goldenScratch, "mega-skillstate.json")

    let replayed = 0
    try {
      for (const goldenCase of golden.cases) {
        const label = "golden: " + goldenCase.name
        const made = createHost({ storage: storageModeFor(goldenCase.storage) })
        made.context.options = goldenCase.options
        const caseDispose = await plugin.default.setup(made.context)
        const event = caseEvent(goldenCase.transcript, goldenCase.sessionID ?? undefined)

        // A host that refuses every store call must *report* it: the capture
        // recorded the lines, so the replay proves the same lines come back.
        const logged = []
        const realError = console.error
        if (goldenCase.storage === "broken") console.error = (line) => logged.push(String(line))
        let report
        try {
          const hook = made.contextHooks[0]
          for (let pass = 0; pass < goldenCase.passes; pass += 1) {
            report = await hook(event)
          }
          if (goldenCase.kind === "command") {
            await made.commands[0].execute({ sessionID: goldenCase.sessionID, prompt: { text: goldenCase.prompt ?? "now" } })
          }
        } finally {
          console.error = realError
          await caseDispose().catch(() => {})
        }

        checkPairing(event.messages, label)
        const cut = cutReport(report)
        const asJson = (value) => JSON.stringify(value)
        assert.equal(asJson(event.messages), asJson(goldenCase.expect.messages), label + ": the outbound messages must be byte-identical")
        assert.equal(asJson(event.system), asJson(goldenCase.expect.system), label + ": the system parts must be byte-identical")
        assert.equal(
          asJson(Object.keys(event.tools).sort()),
          asJson(goldenCase.expect.tools),
          label + ": the offered wire tools must be byte-identical",
        )
        assert.equal(asJson(cut), asJson(goldenCase.expect.report), label + ": the report must be byte-identical")
        if (goldenCase.expect.logged !== undefined) {
          assert.equal(asJson(logged), asJson(goldenCase.expect.logged), label + ": the degraded host's log lines must be byte-identical")
        }
        if (goldenCase.kind === "command") {
          const reply = made.prompts[made.prompts.length - 1].text
          assert.equal(asJson(reply), asJson(goldenCase.expect.reply), label + ": the command reply must be byte-identical")
        }
        replayed += 1
        // One host, one store, one session per case: the in-memory tier is
        // dropped between cases so the replay cannot leak state across them.
        state.resetStateStore()
        row(label, goldenCase.expect.messages.length + " message(s), " + cut.tokensAfter + " tokens, byte-identical")
      }
    } finally {
      rmSync(goldenScratch, { recursive: true, force: true })
    }
    row("golden payloads", replayed + " case(s) replayed byte-for-byte from fixtures/golden.json")
  }
}

// ---------------------------------------------------------------------------
// The Pi adapter: the second host over the same core.
//
// Everything above drives the OpenCode adapter through `server.ts`. The claim
// worth pinning here is that the core is not OpenCode's: the same transform, the
// same Σ write and the same command report arrive through a completely different
// host surface, and a divergence has to show up here rather than in the user's
// install. So this builds a fake Pi from the shapes read out of the installed
// package — a default-export factory handed an `ExtensionAPI` whose
// `registerTool`/`registerCommand`/`appendEntry` are recorded, and whose context
// and command handlers are driven directly.
//
// What it asserts is deliberately the same four rules, answered by different
// seams: registration, the collapse, the durable round-trip (Pi's answer is an
// append log reconstructed from the branch, not a keyed read), and the reply
// channel (`ctx.ui.notify`, guarded on `mode`/`hasUI`).
// ---------------------------------------------------------------------------
{
  // The fake Pi host itself lives in `./pi-host.mjs`, shared with the fixture
  // capture, so the double this file asserts against is the one the golden-pi
  // fixture is recorded through. A second copy would let the harness drift from
  // the fixture it captured.

  // A scratch user-config path for this host, so the layered config reads exactly
  // as it does for the OpenCode run and nothing touches a real home.
  const piScratch = mkdtempSync(join(tmpdir(), "mega-skillstate-pi-"))
  const previousConfig = process.env.MEGA_SKILLSTATE_CONFIG
  process.env.MEGA_SKILLSTATE_CONFIG = join(piScratch, "mega-skillstate.json")

  try {
    // Loaded the way the host loads it: a dynamic import of the module's DEFAULT
    // export, never a static path, so the module tree can move freely.
    const factory = await loadPiFactory(load)
    assert.equal(typeof factory, "function", "the Pi adapter must default-export its factory")

    // --- Registration. -----------------------------------------------------------
    const made = createPiHost()
    factory(made.pi)

    assert.equal(made.tools.length, 1, "the Pi adapter registers one tool")
    assert.equal(made.tools[0].name, "skill_state", "the tool is skill_state, on this host too")
    assert.equal(made.tools[0].label, "skill_state", "Pi requires a UI label the OpenCode mirror has no equivalent of")
    assert.equal(made.tools[0].exposure, "direct", "exposure direct is this host's analogue of codemode false")
    assert.equal(made.commands.length, 1, "the Pi adapter registers one command")
    assert.equal(made.commands[0].name, "skillstate", "the command is /skillstate, on this host too")
    assert.equal(made.commands[0].definition.description.length > 0, true, "the command carries a description")
    assert.equal((made.events["context"] ?? []).length, 1, "one context handler")
    assert.equal((made.events["before_agent_start"] ?? []).length, 1, "one policy push")
    row("pi registration", "1 tool (skill_state, exposure direct), 1 command (/skillstate), 1 context handler")

    // --- The collapse, through a different seam. ----------------------------------
    const piMessages = buildTranscript(20)
    const rawPairs = checkPairing(piMessages, "the raw Pi transcript")
    const piEvent = piContextEvent(piMessages, "ses_pi")
    const piHandler = made.events["context"][0]
    const piReport = await piHandler(piEvent)
    assert.ok(piReport !== undefined, "the Pi context handler returns its report")
    const piState = piMessages[1]
    assert.ok(piState !== undefined, "Σ must be injected on Pi too")
    assert.equal(piState.id, "mega_state", "Σ carries the injected id prefix on this host too")
    const keptRecentPi = OPTIONS.keepRecentTurns * 3
    assert.equal(piMessages.length - 2, keptRecentPi, "the same recent window follows Σ on this host")
    checkPairing(piMessages, "the Pi payload")
    assert.equal(rawPairs - (piMessages.length - 2) > 0, true, "the Pi pass actually collapsed a prefix")
    row("pi collapse", piMessages.length + " message(s), " + piReport.tokensAfter + " tokens, pairs intact")

    // --- The durable round-trip: an append log, not a keyed read. -----------------
    // OpenCode's storage is a KV blob, so a read is a key. Pi has no such seam:
    // `appendEntry` writes and the branch is *reconstructed*. So this walks the branch
    // through the adapter's own `restoreFromBranch` — not a copy of it, because a
    // re-implementation here would prove the smoke satisfies my idea of the walk
    // rather than the one Pi's sessions actually depend on.
    const piStorageModule = await load("src/adapters/pi/storage.ts")
    assert.equal(piStorageModule.STATE_ENTRY_TYPE, "mega_state", "the durable namespace is mega_state")
    const probe = []
    const probeStorage = piStorageModule.createPiStorage({
      appendEntry: (customType, data) => {
        probe.push({ customType, data })
      },
    })

    const before = made.entries.length
    const toolDefinition = made.tools[0]
    const toolCtx = made.makeCtx()
    const toolResult = await toolDefinition.execute(
      "call_pi",
      { state_patch: { objective: "the pi host keeps its own account" } },
      undefined,
      undefined,
      toolCtx,
    )
    assert.equal(made.entries.length, before + 1, "a skill_state write appends a durable entry")
    const appended = made.entries[made.entries.length - 1]
    assert.equal(appended.customType, "mega_state", "the append is namespaced as mega_state")
    assert.equal(appended.data.state.objective, "the pi host keeps its own account", "the appended payload carries Σ")
    assert.ok(toolResult.content[0].text.includes("skill-state updated"), "the write acknowledges")

    const restored = piStorageModule.restoreFromBranch(probeStorage, made.entries)
    assert.ok(restored !== undefined, "the branch walk hands a state back")
    assert.equal(restored.state.objective, "the pi host keeps its own account", "the branch walk reconstructs the same Σ")
    // An empty branch is a first run, not a failure: nothing is restored and the
    // session runs in memory, which is what every host without a store does anyway.
    assert.equal(piStorageModule.restoreFromBranch(probeStorage, []), undefined, "an empty branch restores nothing")
    row("pi durable write", "appended mega_state, branch walk restores Σ")

    // --- The reply channel, and its guard. ------------------------------------------
    // Pi answers through `ctx.ui.notify`, which is not part of a request — so there
    // is no in-flight payload to measure and the command reports on the last one
    // the pass recorded. Both arguments are asserted: the forced pass reports the
    // collapse it ran, and the plain one reports the measurement.
    const commandDefinition = made.commands[0].definition
    await commandDefinition.handler("now", made.makeCtx())
    assert.equal(made.notifications.length, 1, "the forced command replied exactly once")
    assert.equal(made.notifications[0].level, "info", "the reply arrives at info level")
    assert.ok(made.notifications[0].message.includes("context"), "the forced reply reports the context numbers")
    await commandDefinition.handler("", made.makeCtx())
    assert.equal(made.notifications.length, 2, "the plain command replied too")
    assert.ok(made.notifications[1].message.includes("Σ"), "the plain reply prints Σ")

    // The guard is the reason a notify is written behind mode/hasUI at all: a
    // surface with no UI is a write to a channel nobody reads.
    const beforeGuard = made.notifications.length
    await commandDefinition.handler("now", made.makeCtx({ mode: "headless", hasUI: false }))
    assert.equal(made.notifications.length, beforeGuard, "a host with no UI reads no reply")

    row("pi reply channel", "ctx.ui.notify reached for both arguments, guarded without a UI")

    // --- The byte-level baseline: the same claim the OpenCode golden block makes. --
    // The rows above pin behavior by numbers and content. A refactor can pass every
    // one of them while quietly reshaping the payload — the same text in a different
    // part shape, the same report under different keys — so `fixtures/golden-pi.json`
    // is replayed case by case through a fresh host and compared byte for byte.
    //
    // Two things make this Pi's own baseline rather than a copy of OpenCode's. Pi's
    // context event carries no `system` array and its token counts are message-only,
    // so its numbers are not comparable to golden.json's; and the reply channel is
    // `ctx.ui.notify`, not the prompt an OpenCode command writes. A divergence in
    // either shows up here as drift, which is the point.
    //
    // The file is test data and does not ship, so a copy installed from this package
    // still runs: the row says so when the file is absent rather than failing.
    {
      const goldenPiPath = join(root, "fixtures", "golden-pi.json")
      if (!existsSync(goldenPiPath)) {
        row("pi golden payloads", "no fixtures/golden-pi.json — run `node scripts/capture-golden.mjs . . --host pi` to pin the baseline")
      } else {
        const goldenPi = JSON.parse(readFileSync(goldenPiPath, "utf8"))
        assert.equal(goldenPi.schema, 1, "this smoke reads golden-pi schema 1")

        /** The same cut of the report the capture recorded, so the diff is byte-level. */
        const cutReportPi = (report) => ({
          tokensBefore: report.tokensBefore,
          tokensAfter: report.tokensAfter,
          window: report.window ?? null,
          keepRecentTurns: report.keepRecentTurns,
          turns: report.turns,
          currentTurn: report.currentTurn,
          stepsSinceUser: report.stepsSinceUser,
          collapsed: report.collapsed ?? null,
          nudged: report.nudged,
          notes: [...report.notes],
        })

        // A payload with no session id is not a failed pass: the adapter's own guard
        // leaves it exactly as the host built it and hands back the payload rather
        // than a report. That shape carries no `notes` array, so it is compared as
        // it was recorded rather than forced through the report cut above.
        const expectIsGuard = (report) => Array.isArray(report?.notes) === false

        let replayedPi = 0
        try {
          for (const goldenPiCase of goldenPi.cases) {
            const label = "pi golden: " + goldenPiCase.name
            // One host, one session, one store per case: the section's own `made`
            // has already accumulated Σ and a collapsed payload, so reusing it
            // would leak this session's state into every case that followed.
            const madePi = createPiHost()
            const piFactory = await loadPiFactory(load)
            if (piFactory === undefined) throw new Error("src/adapters/pi/index.ts must default-export its factory")
            piFactory(madePi.pi)
            const event = piContextEvent(JSON.parse(JSON.stringify(goldenPiCase.transcript)), goldenPiCase.sessionID)

            let report
            for (let pass = 0; pass < goldenPiCase.passes; pass += 1) {
              report = await madePi.events["context"][0](event)
            }
            if (goldenPiCase.kind === "pi-command") {
              // The same session id the pass recorded, not the host's default: a
              // command asked about a session the pass never saw is a real defect
              // this fixture caught in the capture, not in the adapter.
              await madePi.commands[0].definition.handler(goldenPiCase.prompt ?? "now", madePi.makeCtx({ sessionId: goldenPiCase.sessionID }))
            }

            checkPairing(event.messages, "the Pi golden payload of " + goldenPiCase.name)
            const asJson = (value) => JSON.stringify(value)
            assert.equal(
              asJson(event.messages),
              asJson(goldenPiCase.expect.messages),
              label + ": the outbound messages must be byte-identical",
            )
            // A payload with no session id is not a failed pass: the adapter's guard
            // leaves it exactly as the host built it and hands back the payload
            // rather than a report, with no `notes` array to cut. So the replay
            // derives the recorded shape exactly as the capture does — comparing the
            // bytes only after both halves agree about *which* answer was given.
            const guarded = !Array.isArray(report?.notes)
            assert.equal(
              guarded,
              expectIsGuard(goldenPiCase.expect.report),
              label + ": the guarded shape must agree with what the adapter returned",
            )
            const recordedReport = guarded
              ? { kind: "no-session-guard", messages: event.messages.length }
              : cutReportPi(report)
            assert.equal(asJson(recordedReport), asJson(goldenPiCase.expect.report), label + ": the report must be byte-identical")
            if (goldenPiCase.expect.reply !== undefined) {
              const reply = madePi.notifications[madePi.notifications.length - 1].message
              assert.equal(asJson(reply), asJson(goldenPiCase.expect.reply), label + ": the command reply must be byte-identical")
            }
            replayedPi += 1
            state.resetStateStore()
            row(
              label,
              goldenPiCase.expect.messages.length + " message(s), byte-identical to fixtures/golden-pi.json",
            )
          }
        } finally {
          // A scratch host's tool writes nothing durable that needs tearing down —
          // the append log lives and dies with this case's `madePi` — but the store
          // is reset per case above so the next one cannot inherit this session's Σ.
        }
        row("pi golden payloads", replayedPi + " case(s) replayed byte-for-byte from fixtures/golden-pi.json")
      }
    }
  } finally {
    if (previousConfig === undefined) delete process.env.MEGA_SKILLSTATE_CONFIG
    else process.env.MEGA_SKILLSTATE_CONFIG = previousConfig
    rmSync(piScratch, { recursive: true, force: true })
  }
}

await dispose().catch(() => {})
rmSync(scratchHome, { recursive: true, force: true })
console.log("\nsmoke: ok")