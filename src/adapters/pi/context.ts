/**
 * The transform, as Pi's `context` event meets it.
 *
 * Everything the pass decides is in the host-free core (`src/core/context.ts`); this file
 * is the seam, and it is smaller than OpenCode's by design. Of the three lines that are
 * host-shaped on OpenCode, **two disappear here**:
 *
 * 1. there is no `event.system` array to push into, and nothing to dedupe — the standing
 *    policy is pushed through `before_agent_start`'s `systemPromptOptions` instead, which
 *    is a host-owned object this file reaches structurally;
 * 2. there is no tool wire-offer to write, because `registerTool` declares `skill_state` on
 *    activation. A registered Pi tool is an offered tool, which is precisely the
 *    distinction OpenCode's `codemode: false` had to buy.
 *
 * What is left is the third line — whose session is this — plus building a `TransformInput`
 * from the event and calling `applyTransform`. The transform mutates `event.messages` in
 * place, which is the documented contract for this event: the handler owns the message
 * array, and the host restores the prompt and tool state after it returns.
 *
 * **One honest asymmetry, measured rather than smoothed over.** Pi's `context` event
 * carries no system parts, so `tokensBefore`/`tokensAfter` here are message-only numbers,
 * while OpenCode's include the standing policy. Both are correct for their host; comparing
 * them raw would be the wrong comparison, and the golden fixtures pin each host against
 * its own numbers rather than against each other's.
 *
 * @module mega-skillstate/adapters/pi/context
 */

import { SECTION_TEXT } from "../../core/prompts.ts"
import { applyTransform, type TransformDeps } from "../../core/context.ts"
import type { LastRequest } from "../../core/types.ts"
import { messageOf } from "../../core/types.ts"
import type { ContextEvent, ExtensionAPI } from "./types.ts"

/** What the context registration needs. */
export interface PiContextOptions {
  readonly deps: TransformDeps
  readonly log?: (line: string) => void
  /**
   * The last request the pass saw, handed to whoever needs to answer a command.
   *
   * This is the seam Pi lacks that OpenCode has by accident: there, a tool call or a slash
   * command is answered from inside a request, so the live conversation is simply present.
   * Pi answers through `ctx.ui.notify`, which is not part of a request at all — so the pass
   * has to *record* what it measured for the command to read later. That is why this hook
   * exists and why the last-request map is adapter-held rather than host-provided.
   */
  readonly onRequest?: (sessionID: string, payload: LastRequest) => void
}

/** The session id a context event carries, when it carries one. */
function sessionIdOfEvent(event: ContextEvent): string | undefined {
  const id = (event as { sessionId?: unknown; sessionID?: unknown }).sessionId
  const other = (event as { sessionID?: unknown }).sessionID
  const found = typeof id === "string" && id.length > 0 ? id : typeof other === "string" && other.length > 0 ? other : undefined
  return found
}

/**
 * Push the standing policy into the system prompt options for one turn.
 *
 * The host owns this object, so it is reached structurally and idempotently: a section
 * whose text is already present is not added twice, which is what keeps a provider's
 * prefix cache warm. The exact shape of `NormalizedBuildSystemPromptOptions` was read as
 * a type name from the installed `.d.ts` but not in full — so this walks the object for a
 * section array rather than assuming a field name. If the host ever changes that shape,
 * the *only* consequence is that the policy is not injected, which a smoke row can detect.
 */
function pushPolicy(event: { systemPromptOptions: Record<string, any> }): boolean {
  const options = event.systemPromptOptions
  if (typeof options !== "object" || options === null) return false
  // The section list the host builds its prompt from. Both spellings are checked because
  // the installed type is a re-export whose field list was not measured in full.
  const sections = Array.isArray(options.sections)
    ? options.sections
    : Array.isArray(options.promptSections)
      ? options.promptSections
      : undefined
  if (sections !== undefined) {
    for (const section of sections) {
      if (section !== null && typeof section === "object" && (section as { text?: unknown }).text === SECTION_TEXT) {
        return true
      }
    }
    sections.push({ text: SECTION_TEXT })
    return true
  }
  return false
}

/**
 * Register the pass, and the standing policy that goes with it.
 *
 * @param pi - the host's extension API.
 * @param options - the transform's deps, and an optional log.
 */
export function registerPiContext(pi: ExtensionAPI, options: PiContextOptions): void {
  const { deps } = options

  pi.on("before_agent_start", (event: any) => {
    // The policy is a static section for the whole session, so a failure to push it is
    // loud in the log rather than silent in the payload.
    if (pushPolicy(event) !== true) {
      options.log?.("the standing policy could not be pushed: the host's systemPromptOptions shape is not what this adapter expects")
    }
  })

  pi.on("context", async (event: ContextEvent) => {
    const sessionID = sessionIdOfEvent(event)
    if (sessionID === undefined) {
      // A payload with no session id is left exactly as the host built it — the same rule
      // OpenCode's adapter follows, for the same reason: there is nothing to address.
      return { messages: event.messages ?? [] }
    }
    try {
      return await applyTransform(deps, {
        sessionID,
        model: (event as { model?: unknown }).model,
        // Pi restores the prompt and tool state after the handler, so there are no system
        // parts in scope to measure. An empty list is the honest answer, not a stub.
        system: [],
        messages: event.messages ?? [],
      })
    } catch (error) {
      // A turn must never break because a pass failed.
      options.log?.("the context pass failed and the request continues: " + messageOf(error))
      return { messages: event.messages ?? [] }
    }
  })
}
