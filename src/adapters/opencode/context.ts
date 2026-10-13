/**
 * The transform, as this host's `context` hook meets it.
 *
 * Everything the pass decides lives in the host-free core (`src/core/context.ts`), because
 * the collapse arithmetic, the Σ render and the seed are decisions rather than plumbing.
 * What is left here is the three lines that are genuinely OpenCode-shaped, and they are
 * few enough to name:
 *
 * 1. the standing policy is pushed into `event.system` — deduped by exact text, so a
 *    provider prefix cache stays warm;
 * 2. the tool is put on the wire in `event.tools` — the registry is not the request, and
 *    a tool only reachable through `tool.transform` is a tool the model can never call;
 * 3. the session id is read off the event, and a payload with none is left alone.
 *
 * A second adapter keeps the same three questions and answers them against its own
 * seams: Pi rides `before_agent_start` for the policy, declares `skill_state` at
 * registration so the wire-offer does not exist at all, and takes the session id from its
 * context event.
 *
 * @module mega-skillstate/adapters/opencode/context
 */

import { SECTION_TEXT } from "../../core/prompts.ts"
import {
  applyTransform,
  describeContext,
  estimateTokens,
  measureContext,
  safeBalance,
  windowOf,
  type ContextDescriptor,
  type ContextReport,
  type TransformDeps,
  type TransformInput,
} from "../../core/context.ts"
import { messageOf } from "../../core/types.ts"
import type { Message, SystemPart } from "../../core/types.ts"

// Re-exported so the names this adapter has always answered for still resolve from the
// page the feature map points at, now that the definitions live in the core.
export {
  applyTransform,
  describeContext,
  estimateTokens,
  measureContext,
  messageChars,
  roughTokens,
  safeBalance,
  stripInjected,
  windowOf,
  type ContextDescriptor,
  type ContextReport,
  type TransformDeps,
  type TransformInput,
} from "../../core/context.ts"

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
