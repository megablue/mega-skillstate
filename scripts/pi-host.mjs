/**
 * The fake Pi host, shared by the pinning test and the fixture capture.
 *
 * It exists in one module on purpose. `scripts/smoke.mjs` asserts the Pi adapter's
 * behaviour row by row, and `scripts/capture-golden.mjs` records the Pi adapter's
 * payloads into `fixtures/golden-pi.json` for byte-level replay. If each carried its
 * own copy of this double, a change to the fake would have to be made twice, and a
 * harness that has drifted from the fixture it captured is worse than no harness — it
 * would pin the adapter against a shape nobody is running any more. So both import this.
 *
 * The shapes were read out of the installed `@earendil-works/pi-coding-agent`
 * (`dist/core/extensions/types.d.ts` and `docs/extensions.md`), not assumed: a
 * default-export factory handed an `ExtensionAPI` whose three registrations are
 * recorded rather than discarded, an append-only `appendEntry` that `getBranch()`
 * answers from — which is the whole point, because Pi's durable state is
 * *reconstructed* from the branch rather than read by key — and command contexts
 * whose reply channel is `ctx.ui.notify`, guarded on `mode` and `hasUI`.
 *
 * @module mega-skillstate/harness/pi-host
 */

/**
 * Build a fake `ExtensionAPI` and handlers for one Pi adapter run.
 *
 * @param options - reserved; the OpenCode host takes storage modes and this one has
 *   no equivalent, because the durable surface is the append log rather than a
 *   keyed store.
 */
export function createPiHost(options = {}) {
  const events = {}
  const tools = []
  const commands = []
  const entries = []
  const notifications = []
  const unsubscribes = []
  const pi = {
    on(event, handler) {
      if (events[event] === undefined) events[event] = []
      events[event].push(handler)
      const off = () => {
        const list = events[event] ?? []
        const at = list.indexOf(handler)
        if (at >= 0) list.splice(at, 1)
      }
      unsubscribes.push(off)
      return off
    },
    registerTool(definition) {
      tools.push(definition)
    },
    registerCommand(name, definition) {
      commands.push({ name, definition })
    },
    appendEntry(customType, data) {
      const entry = { customType, data, id: "e" + entries.length }
      entries.push(entry)
      return entry
    },
  }
  // The session manager answers from the append log, which is what makes the
  // durable round-trip a real one: a write lands in the log and a later read of the
  // branch is what a resumed session is rebuilt from.
  const sessionManager = {
    getBranch: () => entries.map((entry) => ({ ...entry })),
  }
  // `mode: "tui"` with `hasUI: true` is the only combination in which a
  // `ctx.ui.notify` reaches a user, so both are set here and one is deliberately
  // flipped in the assertions to prove the guard.
  const makeCtx = (overrides = {}) => ({
    mode: "tui",
    hasUI: true,
    sessionId: "ses_pi",
    sessionManager,
    modelRegistry: {},
    ui: {
      notify: (message, level) => {
        notifications.push({ message: String(message), level: String(level) })
      },
    },
    signal: undefined,
    ctx: {},
    ...overrides,
  })
  return { pi, events, tools, commands, entries, notifications, makeCtx, unsubscribes }
}

/**
 * The context event the Pi adapter's `context` handler is driven with.
 *
 * The session id is passed through verbatim, with **no default**: a case that means
 * "no session id" must actually deliver one that is absent, or the adapter's own
 * guard never runs and the fixture records a normal session instead. That was a real
 * bug — the default made `pi-no-session-id` collapse exactly like
 * `pi-collapse-default`, which pinned the wrong behaviour.
 */
export function piContextEvent(messages, sessionId) {
  return { type: "context", sessionId, messages }
}

/** Load the Pi adapter's default-export factory, the way a Pi host loads it. */
export async function loadPiFactory(load) {
  const piModule = await load("src/adapters/pi/index.ts")
  return typeof piModule.default === "function" ? piModule.default : undefined
}
