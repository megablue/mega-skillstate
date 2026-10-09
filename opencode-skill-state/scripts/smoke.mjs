#!/usr/bin/env node
/**
 * The pinning test for opencode-skill-state's hard rules.
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
 * Run: `node scripts/smoke.mjs .` from `opencode-skill-state/`.
 */

import assert from "node:assert/strict"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve(process.argv[2] ?? ".")
const load = async (relative) => import(pathToFileURL(resolve(root, relative)).href)

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

/** A fake host that records what the plugin registered. */
function createHost() {
  const contextHooks = []
  const tools = []
  const commands = []
  const prompts = []
  const registration = { dispose: async () => {} }
  return {
    tools,
    commands,
    prompts,
    contextHooks,
    context: {
      location: { directory: root },
      options: OPTIONS,
      session: {
        hook: async (name, callback) => {
          assert.equal(name, "context", "this plugin registers a context hook")
          contextHooks.push(callback)
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

console.log("opencode-skill-state smoke — " + root + "\n")

// ---------------------------------------------------------------------------
// Load the plugin the way the host does, and register it against the fake host.
// ---------------------------------------------------------------------------
const plugin = await load("server.ts")
assert.equal(typeof plugin.default, "object", "server.ts must export a default plugin")
assert.equal(plugin.default.id, "opencode-skill-state")
assert.equal(typeof plugin.default.setup, "function", "the plugin must export setup")

const host = createHost()
const dispose = await plugin.default.setup(host.context)
assert.equal(typeof dispose, "function", "setup must hand back a disposer")
assert.equal(host.contextHooks.length, 1, "one context hook")
assert.equal(host.tools.length, 1, "one tool")
assert.equal(host.tools[0].name, "skill_state")
assert.equal(host.commands.length, 1, "one command")
assert.equal(host.commands[0].name, "skillstate")
assert.ok(host.tools[0].output, "the tool declares an output schema, or the host loses its result")
console.log("registered: 1 context hook, 1 tool (skill_state), 1 command (/skillstate)\n")

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
assert.equal(stateMessage.id, "fmac_state", "Σ carries the injected id prefix")
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
const schema = await load("src/schema.ts")

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

const listed = schema.merge({ plan: [{ step: "a", status: "todo" }] }, { plan: [{ step: "b", status: "todo" }] })
assert.equal(listed.plan.length, 1, "an array replaces wholesale")
assert.equal(listed.plan[0].step, "b")

const untouched = schema.merge({ objective: "keep" }, "not an object")
assert.deepEqual(untouched, { objective: "keep" }, "a patch that is not an object changes nothing")

// Rendering is stable, because the injected message must be the same bytes every pass.
const alpha = schema.render({ files: { "b.ts": "read", "a.ts": "read" }, objective: "x" })
const beta = schema.render({ objective: "x", files: { "a.ts": "read", "b.ts": "read" } })
assert.equal(alpha, beta, "the same Σ renders the same bytes whatever order it was written in")

row("merge", "null deletes, unknown keys dropped, arrays replace, objects merge")
row("render", "stable key order, " + alpha.length + " chars")
console.log("")

// ---------------------------------------------------------------------------
// The write channel: `skill_state` applies the patch and says what changed.
// ---------------------------------------------------------------------------
const tool = host.tools[0]
const ack = await tool.execute(
  {
    state_patch: { objective: "bound the window", findings: ["Σ is the record"], not_a_key: 3 },
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

// ---------------------------------------------------------------------------
// The guards: the collapse is conservative by default, and a subagent keeps its own.
// ---------------------------------------------------------------------------
function hostWith(options, overrides = {}) {
  const made = createHost()
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
  offEvent.messages.some((message) => message.id === "fmac_state"),
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
assert.equal(childEvent.messages.some((message) => message.id === "fmac_state"), false)
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
assert.equal(reminder.id, "fmac_notice_stale")
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
console.log("")

await dispose().catch(() => {})
console.log("\nsmoke: ok")