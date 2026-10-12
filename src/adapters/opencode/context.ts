/**
 * The transform: inject Σ, collapse the superseded prefix, seed, nudge.
 *
 * On every `context` event the host rebuilds the durable transcript whole and hands it
 * over, so every pass re-derives the outbound payload from scratch. That is what makes
 * the whole design safe: the transcript is never touched, and a pass is a pure function
 * of (the raw transcript, the in-memory Σ). It is also what makes the pass idempotent by
 * construction — the same conversation and the same Σ always produce the same bytes.
 *
 * One ordering here is load-bearing, and it is not the obvious one:
 *
 * - **Seed first, and from exactly the window that will be kept, then render once.**
 *   Σ is rendered at the moment it is injected. If the seed ran afterwards, the second
 *   pass over the same conversation would render a different Σ from the first, the
 *   payload would drift, and "idempotent" would quietly mean "the last two passes
 *   agreed". Reading the seed first — from the kept window, which is the same window on
 *   every pass — makes the rendered bytes a function of the payload rather than of how
 *   many passes have run.
 *
 * Two rules are never traded away, whatever the configuration:
 *
 * - **A cut only ever lands on a safe boundary** (`selectPrunableRange` walks back to
 *   one), so a `tool-call` is never separated from its `tool-result`.
 * - **A message is only appended at a balanced tail**, so nothing is ever inserted
 *   between a call and its result.
 *
 * @module mega-skillstate/context
 */

import { resolveThresholds, type ResolvedConfig } from "../../core/config.ts"
import { nudgeText, SECTION_TEXT, stateMessageText } from "../../core/prompts.ts"
import { EMPTY_HINTS, seedHints, type SeedHints } from "../../core/seed.ts"
import { stateStore, type StateRecord } from "../../core/state.ts"
import { messageOf } from "./types.ts"
import type { CollapsedSpan, Message, StorageDomain, SystemPart } from "./types.ts"
import {
  balanceCuts,
  firstSelectableIndex,
  isInjectedMessage,
  selectPrunableRange,
  STATE_MESSAGE_ID,
  turnMap,
  turnsOf,
  viewOf,
  type PrunableRange,
  type TurnInfo,
  type ViewNode,
} from "../../core/view.ts"

/** What the transform is allowed to reach outside itself. */
export interface TransformDeps {
  readonly config: ResolvedConfig
  /** The routed model's window, by `providerID/id`. */
  readonly windows?: ReadonlyMap<string, number>
  /** The host's plugin-scoped KV; absent means Σ lives in memory only. */
  readonly storage?: StorageDomain
  readonly log?: (line: string) => void
}

/** Everything one pass needs. */
export interface TransformInput {
  readonly sessionID: string
  readonly model?: unknown
  readonly system: ReadonlyArray<SystemPart>
  readonly messages: Message[]
  /** Whether this session is a child agent's own; the caller reads parentID. */
  readonly isChild?: boolean
  /** Skip the minimum-turn gate; `/skillstate now` uses it. */
  readonly force?: boolean
}

/** The `context` event, as this plugin needs it. */
export interface SessionContextEventLike {
  readonly sessionID: unknown
  readonly model: unknown
  readonly system: SystemPart[]
  readonly messages: Message[]
  readonly tools: Record<string, any>
}

/** What the wire offer for `skill_state` carries. */
export interface ToolWireEntry {
  readonly name: string
  readonly description: string
  readonly input: unknown
}

/** A turn span the collapse replaced. */
export type { CollapsedSpan }

/** Everything the transform decided, printable as it stands. */
export interface ContextReport {
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly window: number | undefined
  readonly keepRecentTurns: number
  readonly turns: number
  readonly currentTurn: number
  readonly stepsSinceUser: number
  /** What the collapse folded in this pass, when it folded anything. */
  readonly collapsed: (CollapsedSpan & { readonly messages: number }) | undefined
  readonly nudged: boolean
  readonly notes: ReadonlyArray<string>
}

/** The context as it stands, measured once and read by the command and the tool alike. */
export interface ContextDescriptor {
  /** The payload as the host wrote it. */
  readonly view: ReadonlyArray<ViewNode>
  /** The call/result balance, or `null` when the payload cannot be balanced. */
  readonly balance: { readonly cuts: ReadonlyArray<boolean>; readonly inFlight: ReadonlyArray<number> } | null
  readonly assignedTurns: ReadonlyArray<number>
  readonly turns: ReadonlyArray<TurnInfo>
  readonly record: StateRecord
  /** Turns always kept verbatim, whatever the pressure. */
  readonly keepRecentTurns: number
  /** Turns a session must have before its superseded prefix is collapsed. */
  readonly minTurns: number
  readonly currentTurn: number
  readonly stepsSinceUser: number
  readonly tokens: number
  readonly window: number | undefined
  /** The turns this session has already collapsed into Σ. */
  readonly collapsed: CollapsedSpan | undefined
  /** The range the collapse would replace now, or `null` when nothing may be replaced. */
  readonly range: PrunableRange | null
}

/**
 * The characters of one message, over four: the floor every estimate falls back to.
 *
 * There is no token meter here — the host does not hand one to a plugin — so the pass
 * prices the payload itself. Four characters per token is the usual rule of thumb for
 * mixed prose and code, and it is deliberately conservative: an estimate that is a
 * little high prunes a little early, which is the safer of the two failures.
 */
export function messageChars(message: Message | undefined): number {
  if (message === undefined) return 0
  let chars = 0
  for (const part of message.content ?? []) {
    if (part.type === "text" || part.type === "reasoning") {
      chars += String((part as { text?: unknown }).text ?? "").length
    } else if (part.type === "tool-call") {
      chars += String((part as { name?: unknown }).name ?? "").length
      chars += JSON.stringify((part as { input?: unknown }).input ?? null).length
    } else if (part.type === "tool-result") {
      chars += valueTextOf(part).length
    } else {
      chars += JSON.stringify(part ?? null).length
    }
  }
  return chars
}

/** The text of one tool-result part, whatever shape the host gave it. */
function valueTextOf(part: unknown): string {
  const value = (part as { result?: { value?: unknown } }).result?.value
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** One message's cost, in tokens. */
export function roughTokens(message: Message | undefined): number {
  return Math.max(1, Math.round(messageChars(message) / 4))
}

/** One string's cost, in tokens, by the same four-characters rule. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(String(text).length / 4))
}

/** The whole payload's cost, system parts included. */
export function measureContext(system: ReadonlyArray<SystemPart>, messages: ReadonlyArray<Message>): number {
  let chars = 0
  for (const part of system) chars += String(part.text ?? "").length
  for (const message of messages) chars += messageChars(message)
  return Math.max(1, Math.round(chars / 4))
}

/** The routed model's window, from the map the model seam was read into. */
export function windowOf(windows: ReadonlyMap<string, number> | undefined, model: unknown): number | undefined {
  if (windows === undefined || windows.size === 0) return undefined
  const ref = model as { providerID?: unknown; id?: unknown } | undefined
  const provider = typeof ref?.providerID === "string" ? ref.providerID : undefined
  const id = typeof ref?.id === "string" ? ref.id : undefined
  if (id === undefined) return undefined
  const keyed = provider === undefined ? undefined : windows.get(provider + "/" + id)
  const found = keyed ?? windows.get(id)
  return typeof found === "number" && found > 0 ? found : undefined
}

/** The balance fold, or `null` when the payload cannot be balanced at all. */
function safeBalance(view: ReadonlyArray<ViewNode>): { cuts: boolean[]; inFlight: number[] } | null {
  try {
    return balanceCuts(view)
  } catch {
    return null
  }
}

/** The id of the newest real user message in a view. */
function lastUserId(view: ReadonlyArray<ViewNode>): string | undefined {
  let found: string | undefined
  for (const node of view) {
    if (node.kind === "user" && typeof node.message.id === "string") found = node.message.id
  }
  return found
}

/**
 * Describe the context: what is there, how big it is, and what may be replaced.
 *
 * The command and the transform answer the same question, so both read the same numbers
 * from this one descriptor. It is a measurement, not a write — the only state it touches
 * is the turn numbering and the step count, both of which are idempotent by
 * construction.
 */
export async function describeContext(deps: TransformDeps, input: TransformInput): Promise<ContextDescriptor> {
  const { config } = deps
  const record = await stateStore(input.sessionID, { storage: deps.storage, log: deps.log })
  const messages = input.messages ?? []
  const view = viewOf(messages)
  const balance = safeBalance(view)
  const assignedTurns = turnMap(view, record)
  const turns = turnsOf(view, assignedTurns)
  const thresholds = resolveThresholds(config)
  const currentTurn = assignedTurns[view.length - 1] ?? 0
  const range =
    balance === null || config.collapseOlder !== true
      ? null
      : selectPrunableRange(view, balance.cuts, assignedTurns, {
          keepRecentTurns: thresholds.keepRecentTurns,
          currentTurn,
          protectFirstUserMessage: config.protectFirstUserMessage,
        })
  record.observeUser(lastUserId(view))
  return {
    view,
    balance,
    assignedTurns,
    turns,
    record,
    keepRecentTurns: thresholds.keepRecentTurns,
    minTurns: thresholds.minTurns,
    currentTurn,
    stepsSinceUser: record.stepsSinceUser,
    tokens: measureContext(input.system, messages),
    window: windowOf(deps.windows, input.model),
    collapsed: record.collapsed(),
    range,
  }
}

/**
 * Drop every message this plugin minted, so a pass starts from the raw transcript.
 *
 * Every message in this namespace is a derived artefact — Σ, a reminder — and every one
 * is rebuilt deterministically from the raw conversation plus Σ. Keeping them would mean
 * a payload that grows by one stale reminder per pass; dropping them is what makes
 * "re-apply from scratch" literally true.
 */
export function stripInjected(messages: Message[]): number {
  let dropped = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isInjectedMessage(messages[index])) {
      messages.splice(index, 1)
      dropped += 1
    }
  }
  return dropped
}

/** The message carrying Σ, as the model reads it. */
function stateMessage(state: Record<string, unknown>, span: CollapsedSpan | undefined): Message {
  return { id: STATE_MESSAGE_ID, role: "user", content: [{ type: "text", text: stateMessageText(state, span) }] }
}

/** The seed, as a Σ patch. Only keys with something to say are set. */
function seedPatch(hints: SeedHints): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (Object.keys(hints.files).length > 0) patch["files"] = hints.files
  if (Object.keys(hints.working).length > 0) patch["working"] = hints.working
  if (hints.step > 0) patch["step"] = hints.step
  return patch
}

/**
 * Run one pass over one request.
 *
 * @returns the report, after mutating `input.messages` in place — the writer is this
 *   module's only side effect, and the durable transcript is never touched.
 */
export async function applyTransform(deps: TransformDeps, input: TransformInput): Promise<ContextReport> {
  const { config } = deps
  const messages = input.messages ?? []
  const notes: string[] = []
  const base = {
    tokensBefore: 0,
    tokensAfter: 0,
    window: undefined as number | undefined,
    keepRecentTurns: config.keepRecentTurns,
    turns: 0,
    currentTurn: 0,
    stepsSinceUser: 0,
    collapsed: undefined as (CollapsedSpan & { readonly messages: number }) | undefined,
    nudged: false,
    notes,
  }
  if (config.enabled !== true) return { ...base, tokensBefore: measureContext(input.system, messages) }
  if (input.isChild === true && config.allowSubagentSessions !== true) {
    notes.push("a subagent session is left alone: allowSubagentSessions is off")
    return { ...base, tokensBefore: measureContext(input.system, messages) }
  }

  // Step 4, and it happens here rather than in the caller so that every path into the
  // transform — the hook, the command's forced pass, the tool's own re-application — is
  // "from scratch". The payload is only ever the raw transcript plus what this pass puts
  // back, which is what makes running it twice over the same array a no-op.
  stripInjected(messages)

  // Reads are async now, because the store may be durable: the LRU is a write-through
  // cache, and a miss costs one `storage.get`. The ⊕ merge itself stays synchronous —
  // load, merge, persist — so the state this pass holds is never a half-applied draft.
  const descriptor = await describeContext(deps, { ...input, messages })
  const { record } = descriptor
  const report: ContextReport = {
    ...base,
    tokensBefore: descriptor.tokens,
    window: descriptor.window,
    keepRecentTurns: descriptor.keepRecentTurns,
    turns: descriptor.turns.length,
    currentTurn: descriptor.currentTurn,
    stepsSinceUser: descriptor.stepsSinceUser,
    notes,
  }

  // --- 6. Collapse the superseded prefix, and put Σ where the prefix was. -----------
  const protect = config.protectFirstUserMessage
  let collapsed: (CollapsedSpan & { readonly messages: number }) | undefined

  if (config.collapseOlder !== true) {
    notes.push("collapseOlder is off, so the prefix is left whole")
  } else if (descriptor.view.length === 0) {
    notes.push("an empty payload has nothing to collapse")
  } else if (descriptor.balance === null) {
    // A payload that cannot be balanced is never cut into, and never appended to: the
    // pairing arithmetic is the only thing that says where a boundary is, and without it
    // there is no boundary to trust.
    notes.push("the payload cannot be balanced, so no cut was attempted")
  } else {
    const range = descriptor.range
    const enoughTurns = input.force === true || descriptor.turns.length >= descriptor.minTurns
    if (range !== null && enoughTurns) {
      const span: CollapsedSpan = {
        from: range.turns[0] ?? 0,
        to: range.turns[range.turns.length - 1] ?? 0,
      }
      // Σ sits exactly where the range starts: immediately after the protected head.
      const at = range.startIdx
      // The seed reads the window that survives, never the prefix that is about to go.
      const hints = config.seedFromTools === true ? seedHints(messages.slice(range.endIdx + 1), config.trackTools) : EMPTY_HINTS
      // Seed, then commit the span, and only then build the text: every write-through is
      // awaited, so by the time `record.get()` is read the store has already been told.
      await record.seed(seedPatch(hints))
      await record.setCollapsed(span)
      try {
        const removed = range.endIdx - at + 1
        messages.splice(at, removed, stateMessage(record.get(), span))
        collapsed = { ...span, messages: removed }
      } catch (error) {
        // The render is the only thing here that can fail, and it is computed before the
        // splice: a refusal leaves the payload exactly as the host built it.
        notes.push("the collapse was refused: " + messageOf(error))
      }
    } else if (range === null && record.collapsed() !== undefined) {
      // Re-apply. A collapse is a commitment, not a one-off: once this session's prefix
      // has been folded into Σ, Σ belongs in every later payload, placed exactly where
      // it was the first time, carrying the span it replaced.
      const span = record.collapsed() as CollapsedSpan
      const at = firstSelectableIndex(descriptor.view, { protectFirstUserMessage: protect })
      const hints = config.seedFromTools === true ? seedHints(messages.slice(at), config.trackTools) : EMPTY_HINTS
      await record.seed(seedPatch(hints))
      try {
        messages.splice(at, 0, stateMessage(record.get(), span))
        collapsed = { ...span, messages: 0 }
      } catch (error) {
        notes.push("Σ could not be put back: " + messageOf(error))
      }
    } else if (range === null) {
      notes.push("nothing is superseded yet: only " + descriptor.turns.length + " turn(s) so far")
    } else {
      notes.push(
        "only " +
          descriptor.turns.length +
          " turn(s) so far, under the " +
          descriptor.minTurns +
          "-turn minimum; /skillstate now collapses anyway",
      )
    }
  }

  // --- 8. A reminder, only when Σ has gone stale, and only at a balanced tail. -------
  let nudged = false
  if (config.nudgeWhenStale === true && descriptor.stepsSinceUser >= config.staleAfter) {
    const tail = safeBalance(viewOf(messages))
    if (tail === null) {
      notes.push("a reminder was held: the payload cannot be balanced")
    } else if ((tail.inFlight[messages.length] ?? 0) > 0) {
      notes.push("a reminder was held: the payload ends inside a tool call")
    } else {
      const id = "mega_notice_stale"
      const text = nudgeText(descriptor.stepsSinceUser)
      const last = messages[messages.length - 1]
      const newest = (last?.content ?? []).find((part) => part.type === "text")
      const says =
        last?.id === id && typeof (newest as { text?: unknown } | undefined)?.text === "string"
      if (!says) {
        messages.push({ id, role: "user", content: [{ type: "text", text }] })
        nudged = true
      } else {
        notes.push("a reminder was held: the newest message already says it")
      }
    }
  }

  const done: ContextReport = {
    ...report,
    tokensAfter: measureContext(input.system, messages),
    collapsed,
    nudged,
    notes,
  }
  if (deps.log !== undefined && config.debug === true) {
    deps.log(
      "context pass: " +
        done.tokensBefore +
        " -> " +
        done.tokensAfter +
        " tokens over " +
        done.turns +
        " turn(s)" +
        (collapsed === undefined ? "" : ", collapsed " + collapsed.from + "-" + collapsed.to + " (" + collapsed.messages + " messages)"),
    )
  }
  return done
}

/**
 * Run the transform for one `context` event.
 *
 * The two event-level steps happen here, before any payload is touched: the standing
 * policy is pushed into `event.system` (deduped by exact text, so a provider prefix
 * cache stays warm), and the tool is put on the wire — the registry is not the request,
 * and a tool only reachable through `tool.transform` is a tool the model can never call.
 *
 * @param deps - what the transform may reach.
 * @param event - the event, mutated in place.
 * @param isChild - whether this session is a subagent's own.
 * @param entry - the wire offer for `skill_state`, from the registered definition.
 */
export async function runContextTransform(
  deps: TransformDeps,
  event: SessionContextEventLike,
  isChild: boolean,
  entry: ToolWireEntry,
): Promise<ContextReport> {
  const { config } = deps
  if (!event.system.some((part) => part.text === SECTION_TEXT)) {
    event.system.push({ type: "text", text: SECTION_TEXT })
  }
  const tools = event.tools as Record<string, unknown> | undefined
  if (tools !== undefined && tools[entry.name] === undefined) {
    // The whole definition rather than just its name: the host builds the offered tool
    // from this map, and the output schema the tool result is validated against has to
    // travel with it.
    tools[entry.name] = { description: entry.description, input: entry.input }
  }
  const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
  if (sessionID === undefined) {
    const tokens = measureContext(event.system, event.messages ?? [])
    return {
      tokensBefore: tokens,
      tokensAfter: tokens,
      window: undefined,
      keepRecentTurns: config.keepRecentTurns,
      turns: 0,
      currentTurn: 0,
      stepsSinceUser: 0,
      collapsed: undefined,
      nudged: false,
      notes: ["a context event with no session id was left alone"],
    }
  }
  return applyTransform(deps, {
    sessionID,
    model: event.model,
    system: event.system,
    messages: event.messages,
    isChild,
  })
}
