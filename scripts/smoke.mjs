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
 * Run: `node scripts/smoke.mjs .` from the repo root.
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
assert.equal(host.compactionHooks.length, 1, "one compaction hook")
assert.equal(host.tools.length, 1, "one tool")
assert.equal(host.tools[0].name, "skill_state")
assert.equal(host.commands.length, 1, "one command")
assert.equal(host.commands[0].name, "skillstate")
assert.ok(host.tools[0].output, "the tool declares an output schema, or the host loses its result")
assert.ok(host.context.storage, "the host's storage seam is wired into the plugin")
console.log("registered: 1 context hook, 1 compaction hook, 1 tool (skill_state), 1 command (/skillstate)\n")

/** The store module, so the restart test can drop the in-memory tier and keep the rest. */
const state = await load("src/state.ts")

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

// A tool write is durable: the store holds what the model committed, keyed by session.
const persisted = host.storage.map.get("state/ses_smoke")
assert.ok(persisted !== undefined, "a state write reaches the durable store")
assert.equal(persisted.state.objective, "bound the window")
assert.deepEqual(persisted.state.findings, ["Σ is the record"])
assert.ok(host.storage.calls.sets.includes("state/ses_smoke"), "the write went through storage.set")
assert.deepEqual(persisted.collapsed, { from: 2, to: 17 }, "the committed span is durable too")
row("durable write", "state/ses_smoke persisted " + Object.keys(persisted.state).join(", "))

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
    state_patch: { objective: "bound the window", findings: ["Σ outlives the process"], done: ["the wrapper module"] },
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
assert.equal(noStoreEvent.messages[1].id, "fmac_state")
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
assert.equal(brokenEvent.messages[1].id, "fmac_state", "and Σ is still injected")
assert.deepEqual(brokenReport.notes, [], "and no failure escapes into the request's account")
checkPairing(brokenEvent.messages, "the payload on a host with a broken store")
row("broken store", "degraded to in-memory, reported, never threw")
console.log("")

await dispose().catch(() => {})
console.log("\nsmoke: ok")