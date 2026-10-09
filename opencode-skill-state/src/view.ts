/**
 * A read-only view of the request the host is about to send, and the pure decisions
 * taken over it.
 *
 * Everything here is a function of `event.messages` — the outbound payload, which this
 * plugin may rewrite but never the durable transcript. A *node* is one message; a tool
 * call and its result are two nodes, paired by `part.id` wherever they sit.
 *
 * The turn-numbering, the call/result balance fold and the prunable-range rules are
 * ported from the working reference plugin rather than reinvented: the pairing
 * arithmetic is the one part of this design where being clever is the same thing as
 * being wrong, and the reference is the ground truth for how this host pairs a call
 * with its result.
 *
 * Three facts drive every rule in this file:
 *
 * 1. Positions, not ids, are what a range is selected by: a node's index in
 *    `messages` is the only ordering that means anything.
 * 2. A range may only be cut where no tool call is waiting for its result. The fold
 *    that decides this is the host's own: a `tool-call` part opens one call, a
 *    `tool-result` part closes it.
 * 3. The host's payload names no turn. This plugin numbers them itself, once per
 *    session, from the user messages it sees — see {@link turnMap}.
 *
 * @module opencode-skill-state/view
 */

import type { ContentPart, Message, ToolCallPart, ToolResultPart } from "./types.ts"

/** What one message is, for the rules that care. */
export type NodeKind = "system" | "user" | "assistant" | "tool" | "injected" | "other"

/** One message, at its position in the outbound payload. */
export interface ViewNode {
  readonly index: number
  readonly message: Message
  readonly kind: NodeKind
  /** Every content part, in order. */
  readonly parts: ReadonlyArray<ContentPart>
}

/** One turn's shape, as the command's per-turn index reads it. */
export interface TurnInfo {
  readonly turn: number
  readonly startIdx: number
  readonly endIdx: number
  readonly nodes: number
  readonly tools: ReadonlySet<string>
  readonly calls: number
}

/** A range that may be replaced, in both position and turn terms. */
export interface PrunableRange {
  readonly startIdx: number
  readonly endIdx: number
  readonly turns: ReadonlyArray<number>
}

/** What the numbering needs from the session's memory. */
export interface TurnMemory {
  /** The turn already assigned to this message id, if this session has seen it. */
  turnOf(id: string): number | undefined
  /** Record a turn for a message id. */
  assignTurn(id: string, turn: number): void
  /** The highest turn number this session has issued, or 0. */
  highestTurn(): number
}

/** The marker every message this plugin mints carries, on its id. */
export const INJECTED_ID_PREFIX = "fmac_"

/** The id the injected Σ message carries — one per session, whatever the request. */
export const STATE_MESSAGE_ID = INJECTED_ID_PREFIX + "state"

/** Is this a message this plugin put into the payload itself? */
export function isInjectedMessage(message: Message | undefined): boolean {
  return typeof message?.id === "string" && message.id.startsWith(INJECTED_ID_PREFIX)
}

/** Is this the message carrying Σ? */
export function isStateMessage(message: Message | undefined): boolean {
  return message?.id === STATE_MESSAGE_ID
}

/** Every tool-call part of one message. */
export function toolCalls(message: Message | undefined): ToolCallPart[] {
  return (message?.content ?? []).filter(
    (part): part is ToolCallPart => part.type === "tool-call" && typeof (part as ToolCallPart).id === "string",
  )
}

/** Every tool-result part of one message. */
export function toolResults(message: Message | undefined): ToolResultPart[] {
  return (message?.content ?? []).filter(
    (part): part is ToolResultPart => part.type === "tool-result" && typeof (part as ToolResultPart).id === "string",
  )
}

/** A tool call's arguments, whether the host handed an object or a JSON string. */
export function parseArguments(part: ToolCallPart): unknown {
  const input = (part as { input?: unknown }).input
  if (typeof input !== "string") return input
  if (input.length === 0) return undefined
  try {
    return JSON.parse(input)
  } catch {
    return undefined
  }
}

/** The text of one tool-result part, whether the host handed a string or a value. */
export function valueText(part: ToolResultPart): string {
  const value = part.result?.value
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function kindOf(message: Message): NodeKind {
  if (isInjectedMessage(message)) return "injected"
  switch (message.role) {
    case "system":
      return "system"
    case "user":
      return "user"
    case "assistant":
      return "assistant"
    case "tool":
      return "tool"
    default:
      return "other"
  }
}

/** Flatten the payload into positional nodes. */
export function viewOf(messages: ReadonlyArray<Message>): ViewNode[] {
  return messages.map((message, index) => ({
    index,
    message,
    kind: kindOf(message),
    parts: message.content ?? [],
  }))
}

/**
 * Fold the tool-call/result balance over the payload.
 *
 * @returns `cuts` where `cuts[i]` is true when the cut *before* node `i` splits no
 *   call, and `inFlight` where `inFlight[i]` is how many calls are open before node
 *   `i`.
 * @throws when a result has no call: a payload like that is corrupt, and every later
 *   rule would be reasoning about a conversation that never happened.
 */
export function balanceCuts(view: ReadonlyArray<ViewNode>): {
  cuts: boolean[]
  inFlight: number[]
} {
  const cuts = [true]
  const inFlight = [0]
  let open = 0
  for (const node of view) {
    open += toolCalls(node.message).length
    open -= toolResults(node.message).length
    if (open < 0) {
      throw new Error(
        `view: a tool result at message ${node.index} (${node.message.id ?? "no id"}) has no matching tool call`,
      )
    }
    cuts.push(open === 0)
    inFlight.push(open)
  }
  return { cuts, inFlight }
}

/**
 * Number every node's turn, remembering the answer per message id.
 *
 * The host's payload carries no turn field, so this plugin numbers turns itself and
 * keeps the numbering in the session's memory. A real user message opens the next
 * turn — the message that asks the question belongs to the turn that answers it — and
 * a message already seen keeps the number it was given, so a range addressed by turn
 * number keeps meaning the same stretch of conversation however the payload is
 * trimmed. Everything before the first user message is turn 0, as is a message this
 * plugin injected.
 *
 * @param view - a {@link viewOf}.
 * @param memory - the session's numbering memory.
 * @returns one turn number per node index.
 */
export function turnMap(view: ReadonlyArray<ViewNode>, memory: TurnMemory): number[] {
  let current = 0
  let highest = Math.max(0, memory.highestTurn())
  const assigned: number[] = []
  for (const node of view) {
    const id = typeof node.message.id === "string" ? node.message.id : undefined
    const known = id === undefined ? undefined : memory.turnOf(id)
    let turn: number
    if (node.kind === "user") {
      if (known === undefined) {
        highest += 1
        turn = highest
      } else {
        turn = known
        if (turn > highest) highest = turn
      }
      current = turn
    } else {
      turn = known ?? current
      if (turn > highest) highest = turn
    }
    if (id !== undefined && known === undefined) memory.assignTurn(id, turn)
    assigned.push(turn)
  }
  return assigned
}

/** Group the payload into turns. */
export function turnsOf(view: ReadonlyArray<ViewNode>, assignedTurns: ReadonlyArray<number>): TurnInfo[] {
  const turns: TurnInfo[] = []
  let current: { turn: number; startIdx: number; endIdx: number; nodes: number; tools: Set<string>; calls: number } | null =
    null
  view.forEach((node, position) => {
    const turn = assignedTurns[position] ?? 0
    if (current === null || current.turn !== turn) {
      current = {
        turn,
        startIdx: position,
        endIdx: position,
        nodes: 0,
        tools: new Set(),
        calls: 0,
      }
      turns.push(current)
    }
    current.endIdx = position
    current.nodes += 1
    for (const part of toolCalls(node.message)) {
      current.tools.add(part.name)
      current.calls += 1
    }
  })
  return turns
}

/**
 * The first index a range may start at.
 *
 * A system message is never shadowed, and neither is the session's first real user
 * message while `protectFirstUserMessage` is on: it is the instruction the whole session
 * answers, and a state message that swallowed it would leave the model working on a
 * memory of its assignment.
 */
export function firstSelectableIndex(
  view: ReadonlyArray<ViewNode>,
  options: { protectFirstUserMessage?: boolean } = {},
): number {
  let start = 0
  while (start < view.length && view[start].kind === "system") start += 1
  if (options.protectFirstUserMessage !== false) {
    for (let index = start; index < view.length; index += 1) {
      if (view[index].kind === "user") {
        start = index + 1
        break
      }
    }
  }
  // A message this plugin minted is a state summary of a stretch that is already gone:
  // collapsing it again would summarise a summary.
  while (start < view.length && view[start].kind === "injected") start += 1
  return start
}

/**
 * The oldest range that may be replaced, keeping the configured recent turns.
 *
 * @param options - `{ keepRecentTurns, currentTurn, protectFirstUserMessage }`.
 * @returns the range, or `null` when nothing may be replaced yet.
 */
export function selectPrunableRange(
  view: ReadonlyArray<ViewNode>,
  cuts: ReadonlyArray<boolean>,
  assignedTurns: ReadonlyArray<number>,
  options: { keepRecentTurns?: number; currentTurn?: number; protectFirstUserMessage?: boolean },
): PrunableRange | null {
  if (view.length === 0) return null
  const keep = Math.max(0, options.keepRecentTurns ?? 0)
  const currentTurn = options.currentTurn ?? assignedTurns[view.length - 1] ?? 0
  const oldestKeptTurn = currentTurn - keep + 1
  let cut = view.length
  for (let index = 0; index < view.length; index += 1) {
    if (assignedTurns[index] >= oldestKeptTurn) {
      cut = index
      break
    }
  }
  // The live turn is never cut into: its instruction is the step being taken, and a
  // state message that swallowed it would leave the model working on a memory.
  const currentTurnStart = assignedTurns.indexOf(currentTurn)
  if (currentTurnStart >= 0) cut = Math.min(cut, currentTurnStart)
  const start = firstSelectableIndex(view, options)
  // Walk back to a safe boundary rather than cutting inside a tool pair. The walk is
  // the whole safety story: it can only ever move the cut *later*, which keeps more.
  while (cut > start && cuts[cut] !== true) cut -= 1
  if (cut <= start) return null
  const endIdx = cut - 1
  return {
    startIdx: start,
    endIdx,
    turns: [...new Set(assignedTurns.slice(start, cut))],
  }
}
