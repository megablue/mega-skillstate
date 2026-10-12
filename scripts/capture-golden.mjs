#!/usr/bin/env node
/**
 * Capture the golden payload fixtures — the pre-move baseline of Phase 1.
 *
 * The core extraction (`docs/ROADMAP.md`, Phase 1) claims *zero behavior change*.
 * `scripts/smoke.mjs` already pins behavior by ack texts, numbers and content
 * assertions, but a refactor can change the payload's bytes while every one of
 * those still passes — a message with the same content in a different shape, a
 * report with the same numbers under different keys. The only thing that
 * survives that is a byte-for-byte replay: drive the plugin through its public
 * surface (the host entry, the fake host, the real `context`/command hooks),
 * serialise exactly what the host would put on the wire, and diff those bytes
 * after the move.
 *
 * So this script is run **before** the modules move, and it writes
 * `fixtures/golden.json`: for every case, the input (the transcript, the
 * options, the storage mode, the session id, the number of passes) alongside
 * the expected output (the outbound messages, the system parts, the offered
 * tool keys, the report's numbers and notes). `scripts/smoke.mjs` replays the
 * same file after the move and fails on the first byte that differs.
 *
 * The harness is deliberately the smoke test's: the same fake host, the same
 * deterministic corpus and filler, the same redirected user-config path — so
 * what is recorded is the behavior the pinning test already measures, not a
 * second harness that could drift from it.
 *
 * The golden file is committed: a future intentional behavior change regenerates
 * it and the diff is the review of that change.
 *
 * Run: `node scripts/capture-golden.mjs .` from the repo root.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve(process.argv[2] ?? ".")
const outDir = resolve(process.argv[3] ?? join(root, "fixtures"))
const load = async (relative) => import(pathToFileURL(resolve(root, relative)).href)

/**
 * The user-level config path is redirected before the plugin is loaded, exactly
 * as in the smoke test: `setup` writes that file when it is missing, and this
 * capture must never touch a real home.
 */
const scratchHome = mkdtempSync(join(tmpdir(), "mega-skillstate-golden-"))
process.env.MEGA_SKILLSTATE_CONFIG = join(scratchHome, "mega-skillstate.json")

/** The routed model, and the window the model seam hands the plugin. */
const MODEL = { providerID: "opencode-go", id: "step-5-preview-free" }
const WINDOW = 128000

/** Deterministic filler, so every byte below is reproducible. */
function filler(tag, size) {
  let out = tag + " "
  while (out.length < size) {
    out += "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor "
  }
  return out.slice(0, size)
}

/** The smoke test's uniform corpus: a head, then `turns` turns of one paired call. */
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

/**
 * A second shape, so the golden corpus is not one turn archetype: an assistant
 * carrying **two** calls at once, a text-only turn with no call, and results in
 * their own messages — the shapes the pairing arithmetic has to survive a cut
 * around, and a naive message-count splice would break.
 */
function buildMixedTranscript(turns = 12) {
  const messages = [
    { id: "u_head", role: "user", content: [{ type: "text", text: filler("the assignment", 900) }] },
  ]
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push({
      id: "u_" + turn,
      role: "user",
      content: [{ type: "text", text: filler("turn " + turn + " instruction", 180) }],
    })
    if (turn % 4 === 0) {
      messages.push({
        id: "a_text_" + turn,
        role: "assistant",
        content: [{ type: "text", text: filler("assistant prose for turn " + turn, 140) }],
      })
      continue
    }
    const read = "call_" + turn + "_read"
    const grep = "call_" + turn + "_grep"
    messages.push({
      id: "a_" + turn,
      role: "assistant",
      content: [
        { type: "reasoning", text: filler("reasoning for turn " + turn, 240) },
        { type: "tool-call", id: read, name: "read", input: { file_path: "src/mixed" + turn + ".ts", limit: 100 } },
        { type: "tool-call", id: grep, name: "grep", input: { pattern: "skill-state", path: "src" } },
      ],
    })
    messages.push({
      id: "r_" + turn + "_read",
      role: "tool",
      content: [
        { type: "tool-result", id: read, name: "read", result: { type: "text", value: filler("read result " + turn, 1600) } },
      ],
    })
    messages.push({
      id: "r_" + turn + "_grep",
      role: "tool",
      content: [
        { type: "tool-result", id: grep, name: "grep", result: { type: "text", value: filler("grep result " + turn, 700) } },
      ],
    })
  }
  return messages
}

/** A `context` event, as the host builds one. */
function buildEvent(messages, sessionID) {
  return { sessionID, agent: "build", model: MODEL, system: [], messages, tools: {} }
}

/**
 * A fake `ctx.storage`: a Map, with the real boundary semantics — values cross
 * it as copies, exactly as they cross the host's JSON store.
 */
function createStorage() {
  const map = new Map()
  return {
    domain: {
      get: async (key) => (map.has(key) ? structuredClone(map.get(key)) : undefined),
      set: async (key, value) => {
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
 * @param options.storage - `"none"` for a host with no storage seam at all;
 *   `"broken"` for one whose store refuses every call (the degradation the
 *   plugin must survive, and record in its log).
 */
function createHost(options = {}) {
  const contextHooks = []
  const compactionHooks = []
  const tools = []
  const commands = []
  const prompts = []
  const registration = { dispose: async () => {} }
  const storage = options.storage === "none" || options.storage === "broken" ? undefined : createStorage()
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
      : storage?.domain
  return {
    tools,
    commands,
    prompts,
    contextHooks,
    compactionHooks,
    storage,
    context: {
      location: { directory: root },
      options: options.options ?? {},
      session: {
        hook: async (name, callback) => {
          if (name === "context") contextHooks.push(callback)
          else if (name === "compaction") compactionHooks.push(callback)
          return registration
        },
        get: async ({ sessionID }) => ({ id: sessionID }),
        context: async () => [],
        prompt: async (input) => {
          prompts.push(input)
        },
      },
      tool: {
        transform: async (callback) => {
          callback({ add: (definition) => tools.push(definition) })
          return registration
        },
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
        if (open.has(part.id)) throw new Error(label + ": call " + part.id + " appears twice")
        open.add(part.id)
        calls += 1
      } else if (part.type === "tool-result") {
        if (!open.has(part.id)) throw new Error(label + ": result " + part.id + " has no call before it — the pair is split")
        open.delete(part.id)
        results += 1
      }
    }
  }
  if (open.size > 0) throw new Error(label + ": " + open.size + " call(s) left without a result")
  if (calls !== results) throw new Error(label + ": " + calls + " call(s) and " + results + " result(s)")
}

/** The report, reduced to the fields a byte-diff should watch. */
function cutReport(report) {
  return {
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
  }
}

function snapshot(event) {
  return {
    messages: JSON.parse(JSON.stringify(event.messages)),
    system: JSON.parse(JSON.stringify(event.system)),
    tools: Object.keys(event.tools).sort(),
  }
}

const plugin = await load("server.ts")
if (typeof plugin.default?.setup !== "function") throw new Error("server.ts must export a default plugin with setup")

const cases = []
const row = (label, value) => console.log("  " + label.padEnd(34, ".") + " " + value)

/**
 * Drive one `context` case: load the plugin against a fresh host, run the hook
 * `passes` times over one event, and record the payload as the host would send it.
 */
async function captureContext(name, spec) {
  // Two copies, and they must never be the same array. `buildEvent` does not copy
  // what it is handed, and the hook splices its event's messages *in place* — so
  // the array the event carries is the output by the time the passes finish.
  // `input` is what the fixture records, and it is never handed to anything that
  // could touch it; the event gets a copy of its own to own and mutate.
  const input = JSON.parse(JSON.stringify(spec.transcript))
  const host = createHost({ storage: spec.storage ?? "map", options: spec.options ?? {} })
  const dispose = await plugin.default.setup(host.context)
  const event = buildEvent(JSON.parse(JSON.stringify(spec.transcript)), spec.sessionID)
  let report
  const logged = []
  const realError = console.error
  if (spec.storage === "broken") console.error = (line) => logged.push(String(line))
  try {
    for (let pass = 0; pass < (spec.passes ?? 1); pass += 1) {
      report = await host.contextHooks[0](event)
    }
  } finally {
    console.error = realError
    await dispose()
  }
  checkPairing(event.messages, "the golden payload of " + name)
  const shot = snapshot(event)
  const entry = {
    name,
    kind: "context",
    options: spec.options ?? {},
    storage: spec.storage ?? "map",
    sessionID: spec.sessionID ?? null,
    transcript: input,
    passes: spec.passes ?? 1,
    expect: { ...shot, report: cutReport(report) },
  }
  if (spec.storage === "broken") entry.expect.logged = logged
  row(name, entry.expect.messages.length + " message(s), " + report.tokensAfter + " tokens" + (report.collapsed ? ", turns " + report.collapsed.from + "-" + report.collapsed.to : ""))
  return entry
}/**
 * Drive one `command` case: a pass first, so the command measures a remembered
 * payload, then the invocation itself — the reply text is part of the wire.
 */
async function captureCommand(name, spec) {
  // The same in-place mutation as the context cases, one step further along:
  // the forced pass of `/skillstate now` splices the very array the event holds.
  // So the event carries its own copy to own and mutate, and `input` — the copy
  // the fixture records — is never handed to the plugin at all.
  const input = JSON.parse(JSON.stringify(spec.transcript))
  const host = createHost({ storage: spec.storage ?? "map", options: spec.options ?? {} })
  const dispose = await plugin.default.setup(host.context)
  const event = buildEvent(JSON.parse(JSON.stringify(spec.transcript)), spec.sessionID)
  const report = await host.contextHooks[0](event)
  await host.commands[0].execute({ sessionID: spec.sessionID, prompt: { text: spec.prompt ?? "now" } })
  const reply = host.prompts[host.prompts.length - 1].text
  const shot = snapshot(event)
  await dispose()
  row(name, "reply " + reply.length + " chars")
  return {
    name,
    kind: "command",
    options: spec.options ?? {},
    storage: spec.storage ?? "map",
    sessionID: spec.sessionID ?? null,
    transcript: input,
    prompt: spec.prompt ?? "now",
    passes: 1,
    expect: { ...shot, report: cutReport(report), reply },
  }
}

console.log("mega-skillstate golden capture — " + root + "\n")

// (1) The default collapse: the smoke test's own 20-turn corpus, two passes, so
// the byte-identity of the payload across a re-apply is part of the baseline.
cases.push(
  await captureContext("collapse-default", {
    options: { keepRecentTurns: 4, min: 4, staleAfter: 8 },
    sessionID: "ses_golden_default",
    transcript: buildTranscript(20),
    passes: 2,
  }),
)

// (2) A second shape: two calls per assistant, text-only turns, a narrower
// window — the cut lands a different distance into a different structure.
cases.push(
  await captureContext("mixed-shape-span", {
    options: { keepRecentTurns: 2, min: 4, staleAfter: 8 },
    sessionID: "ses_golden_mixed",
    transcript: buildMixedTranscript(12),
    passes: 2,
  }),
)

// (3) Seeding off: the same collapse with no seed patch, so the rendered Σ in the
// payload carries only what the model wrote and the derived floor is absent.
cases.push(
  await captureContext("seed-off", {
    options: { keepRecentTurns: 4, min: 4, seedFromTools: false },
    sessionID: "ses_golden_seed_off",
    transcript: buildTranscript(20),
    passes: 1,
  }),
)

// (4) A narrow window: keepRecentTurns 2, so the kept slice is the tail the
// config-layers row measures, and the seed reads exactly that slice.
cases.push(
  await captureContext("keep-narrow", {
    options: { keepRecentTurns: 2, min: 4, staleAfter: 8 },
    sessionID: "ses_golden_narrow",
    transcript: buildTranscript(20),
    passes: 1,
  }),
)

// (5) The stale reminder: four passes over a session with no new user message,
// so the third is the last quiet one and the fourth carries `mega_notice_stale`.
cases.push(
  await captureContext("stale-nudge", {
    options: { keepRecentTurns: 4, min: 4, staleAfter: 3 },
    sessionID: "ses_golden_stale",
    transcript: buildTranscript(20),
    passes: 4,
  }),
)

// (6) `/skillstate now`: the command path — a forced pass over the remembered
// payload, and the reply text the user reads.
cases.push(
  await captureCommand("command-now", {
    options: { keepRecentTurns: 4, min: 4, staleAfter: 8 },
    sessionID: "ses_golden_now",
    transcript: buildTranscript(20),
    prompt: "now",
  }),
)

// (7) No session id: the host's own guard — the payload is measured and returned
// untouched, and the note says why.
cases.push(
  await captureContext("no-session-id", {
    options: { keepRecentTurns: 4, min: 4, staleAfter: 8 },
    sessionID: undefined,
    transcript: buildTranscript(20),
    passes: 1,
  }),
)

// (8) A store that refuses everything: degraded to memory, reported to the log,
// and the collapse is unchanged.
cases.push(
  await captureContext("broken-store", {
    options: { keepRecentTurns: 4, min: 4, staleAfter: 8, debug: true },
    storage: "broken",
    sessionID: "ses_golden_broken",
    transcript: buildTranscript(20),
    passes: 1,
  }),
)

mkdirSync(outDir, { recursive: true })
const golden = { schema: 1, cases }
writeFileSync(join(outDir, "golden.json"), JSON.stringify(golden, null, 2) + "\n", "utf8")
row("wrote", join(outDir, "golden.json") + " (" + cases.length + " case(s))")

rmSync(scratchHome, { recursive: true, force: true })
console.log("\ngolden capture: ok")
