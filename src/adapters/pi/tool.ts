/**
 * `skill_state`, as Pi's tool registry wants it.
 *
 * Everything about *whether* a patch is well formed lives in the host-free core
 * (`src/core/skill-state.ts`); this is the registration envelope around it, plus the one
 * thing that is genuinely Pi's: the tool declares itself on registration.
 *
 * That last fact is what makes this file simpler than it would otherwise be. On OpenCode
 * the registry and the request are two different things — a registered tool still has to
 * be *offered* to the model, which is why the OpenCode adapter carries a wire-offer write
 * into the context event. Here `exposure: "direct"` activates the tool at registration,
 * so the two problems collapse into one: registering it puts it in front of the model by
 * name, with no per-request plumbing at all.
 *
 * The `execute` signature is the other Pi-shaped part. Five arguments, not OpenCode's two:
 * a call id, the parsed parameters, an abort signal, an update callback, and a context.
 * The first four are unused; only the context carries what this call needs, and the
 * session id is on it as `ctx.sessionId` rather than as a sibling of the arguments.
 *
 * @module mega-skillstate/adapters/pi/tool
 */

import {
  TOOL_INPUT,
  TOOL_NAME,
  TOOL_OUTPUT,
  runSkillState,
  skillStateDescription,
} from "../../core/skill-state.ts"
import type { ResolvedConfig } from "../../core/config.ts"
import type { StorageDomain } from "../../core/types.ts"
import type { ExtensionToolContext, PiToolDefinition, PiToolResult } from "./types.ts"

/** The model-facing description: the schema and the contract, as the core writes it. */
function toolLabel(): string {
  // A UI label is a short name for the tool, not a description of it. The core describes
  // the tool for the model; the label is the one word a user sees in a call trace.
  return TOOL_NAME
}

/**
 * Build `skill_state` for Pi's registry.
 *
 * @param options - the durable store, when the host has one, so a write outlives the
 *   process that made it; the resolved config, so a Σ past the size line is folded.
 * @returns the tool definition, ready for `registerTool`.
 */
export function createPiSkillState(
  options: { readonly storage?: StorageDomain; readonly config?: ResolvedConfig } = {},
): PiToolDefinition {
  const storage = options.storage
  const config = options.config
  return {
    name: TOOL_NAME,
    label: toolLabel(),
    description: skillStateDescription(),
    parameters: TOOL_INPUT,
    outputSchema: TOOL_OUTPUT,
    // Measured: `direct` activates the tool on registration, which is this plugin's
    // equivalent of OpenCode's `codemode: false`. The other exposures are measured but
    // unused here — a tool reached through a wrapper rather than by name is not what the
    // policy text tells the model to call.
    exposure: "direct",
    execute: async (
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionToolContext,
    ): Promise<PiToolResult> => {
      // The whole decision — parse, validate, merge, persist, acknowledge, or read the
      // archive back — is one core call reaching the same seam the OpenCode tool does.
      // This line is the host's only contribution: where the session id lives, and which
      // fields are the model's.
      const write = {
        sessionID: ctx?.sessionId,
        state_patch: params?.state_patch,
        step: params?.step,
        summary: params?.summary,
        recall: params?.recall,
      }
      const outcome = await runSkillState(write, { storage, config })
      return { content: [{ type: "text", text: outcome.text }], details: outcome.output }
    },
  }
}
