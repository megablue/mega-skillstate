/**
 * mega-skillstate — bound the context window with an explicit, structured
 * execution state instead of an append-only conversation history.
 *
 * Four contributions, registered from one `setup`:
 *
 * 1. a standing prompt section stating the policy — Σ is the record, and anything not
 *    written to it goes with the turn that knew it;
 * 2. a transform on every request's `context` hook that injects Σ and collapses the
 *    superseded prefix into it, so the outbound payload is ≈ `P + Σ + recent window`;
 * 3. `skill_state`, the tool the model uses to write Σ: a dictionary merge the runtime
 *    validates, where a `null` deletes a key and an unknown key is dropped;
 * 4. `/skillstate`, the same context measured and printed, plus `now` to force a
 *    collapse this pass.
 *
 * Nothing here edits the durable transcript: the transform rewrites the payload the host
 * is about to send, and it is re-derived on every request from the raw transcript and
 * the in-memory Σ. Cuts happen only at safe turn boundaries, so a `tool-call` is never
 * separated from its `tool-result`.
 *
 * @module mega-skillstate
 */

import type { Plugin } from "@opencode/plugin"

import { fileURLToPath } from "node:url"

import { createSkillStateCommand, type SkillStateCommandOptions } from "./command.ts"
import { PLUGIN, ensureUserConfig, resolveConfig, resolveOptions, userConfigPath } from "./config.ts"
import { runCompaction } from "./compaction.ts"
import { messageOf, runContextTransform, type TransformDeps } from "./context.ts"
import { MAX_SESSIONS } from "./state.ts"
import { TOOL_NAME, createSkillState } from "./tool.ts"
import type {
  LastRequest,
  Message,
  PluginContext,
  Registration,
  SessionContextEvent,
  SystemPart,
} from "./types.ts"

/** Where an installed copy keeps its own options: the package root, one level above `src/`. */
const OPTIONS_PATH = fileURLToPath(new URL("../options.json", import.meta.url))

/** The plugin's id: the package name, and the label a message of its own is attributed to. */
export const id = PLUGIN

/**
 * Is this session a child agent's own conversation?
 *
 * The host's session record carries `parentID`; a subagent's session has one, a
 * top-level session does not. The answer is cached per session, because the check costs
 * a host call and parentage never changes.
 */
async function isChildSession(
  ctx: PluginContext,
  sessionID: string,
  cache: Map<string, boolean>,
  allowSubagentSessions: boolean,
): Promise<boolean> {
  if (allowSubagentSessions === true) return false
  const known = cache.get(sessionID)
  if (known !== undefined) return known
  let child = false
  try {
    const info = (await ctx.session.get({ sessionID })) as { parentID?: unknown } | undefined
    child = typeof info?.parentID === "string" && info.parentID.length > 0
  } catch {
    // A host that will not answer is treated as one without child sessions: the
    // transform then runs, which is the behaviour of every host measured so far.
    child = false
  }
  cache.set(sessionID, child)
  return child
}

/**
 * Register what this plugin contributes and hand back its undo.
 *
 * @param ctx - the host's plugin context.
 * @returns a cleanup that disposes every registration, newest first.
 */
export async function setup(ctx: PluginContext): Promise<() => Promise<void>> {
  const warn = (line: string): void => {
    try {
      console.error("[" + PLUGIN + "] " + line)
    } catch {
      // A host without a console still gets the plugin's behaviour, not its notes.
    }
  }

  // The user-level file is the plugin's own half of the config surface, and it does not
  // exist on a first run: it is written with every default before anything reads it, so
  // the file a user edits is one they were given first. A home that cannot be written to
  // is reported and the plugin still loads — the file is a convenience, the layers fall
  // through to the defaults without it.
  const userFile = userConfigPath()
  try {
    if (ensureUserConfig(userFile) === true) warn("wrote the default configuration to " + userFile)
  } catch (error) {
    warn("the user-level configuration at " + userFile + " could not be written: " + messageOf(error))
  }

  // A refused configuration is loud on purpose: a context policy that quietly keeps a
  // default is worse than one that refuses to load. Three layers, most specific last:
  // the host's own entry, the user's file (above), the copy an install carries. A copy
  // installed into a discovery directory needs its own `options.json` because that
  // install has no entry to hand it any (measured).
  const config = resolveConfig(resolveOptions(ctx.options, OPTIONS_PATH, userFile))
  const registrations: Registration[] = []

  const disposeAll = async (): Promise<void> => {
    for (const registration of registrations.splice(0).reverse()) {
      await registration.dispose()
    }
  }

  if (config.enabled !== true) return disposeAll

  /** The routed model's window, by `providerID/id`, read once from the model registry. */
  const windows = new Map<string, number>()
  registrations.push(
    await ctx.model.transform((editor) => {
      for (const model of editor.list() as ReadonlyArray<any>) {
        const context = Number(model?.limit?.context)
        const modelID = typeof model?.id === "string" ? model.id : undefined
        const provider = typeof model?.providerID === "string" ? model.providerID : undefined
        if (modelID === undefined || !Number.isFinite(context) || context <= 0) continue
        if (provider !== undefined) windows.set(provider + "/" + modelID, context)
        if (!windows.has(modelID)) windows.set(modelID, context)
      }
    }),
  )

  const deps: TransformDeps = {
    config,
    windows,
    // Absent on a host without a storage seam: every use is guarded and the store
    // degrades to in-memory, which is what this plugin did before one existed.
    storage: ctx.storage,
    log: (line) => {
      if (config.debug === true) warn(line)
    },
  }

  /**
   * The last request each session's context hook saw.
   *
   * A tool call is answered from inside a request, so this is the live conversation a
   * `skill_state` call or a `/skillstate` invocation is about. The map is bounded like the
   * session state is, and inserting an existing key moves it to the newest end.
   */
  const payloads = new Map<string, LastRequest>()
  const remember = (sessionID: string, payload: LastRequest): void => {
    payloads.delete(sessionID)
    payloads.set(sessionID, payload)
    while (payloads.size > MAX_SESSIONS) {
      const oldest = payloads.keys().next().value
      if (oldest === undefined) break
      payloads.delete(oldest)
    }
  }

  const tool = createSkillState({ storage: ctx.storage })
  const commandOptions: SkillStateCommandOptions = {
    deps,
    payloadOf: (sessionID) => payloads.get(sessionID),
    reply: async (sessionID, text) => {
      await ctx.session.prompt({ sessionID, text })
    },
  }
  const command = createSkillStateCommand(commandOptions)

  const childCache = new Map<string, boolean>()
  registrations.push(
    await ctx.session.hook("context", async (event: SessionContextEvent) => {
      try {
        const sessionID = typeof event.sessionID === "string" ? event.sessionID : undefined
        if (sessionID !== undefined) {
          remember(sessionID, {
            model: event.model,
            system: event.system,
            messages: event.messages,
          })
        }
        const isChild =
          sessionID === undefined
            ? false
            : await isChildSession(ctx, sessionID, childCache, config.allowSubagentSessions)
        // The report is returned for the caller's benefit (the smoke test reads the
        // measured numbers off it); the host ignores it.
        return await runContextTransform(deps, event, isChild, {
          name: TOOL_NAME,
          description: tool.description,
          input: tool.input,
        })
      } catch (error) {
        // A turn must never break because a pass failed.
        warn("the context pass failed and the request continues: " + messageOf(error))
      }
    }),
  )

  // The compaction seam: the SKILL.state centerpiece. The model maintains Σ semantically
  // through `skill_state` as it works; when the host needs a compaction message, this
  // plugin hands back `render(Σ)` and no model call happens at all. `event.messages` is
  // read and never written.
  registrations.push(
    await ctx.session.hook("compaction", async (event) => {
      try {
        const report = await runCompaction(deps, event as never)
        if (config.debug === true) warn("compaction: " + (report.owned ? "owned" : "declined"))
        return report
      } catch (error) {
        // Declining means the host summarises, which is what would have happened without
        // this plugin at all.
        warn("the compaction pass was refused and the host summarises: " + messageOf(error))
        return undefined
      }
    }),
  )

  registrations.push(
    await ctx.tool.transform((editor) => {
      editor.add(tool)
    }),
  )

  // `manualCommand: false` means the user does not want the slash command; the tool and
  // the pass are unaffected, which is the point of the key being separate.
  if (config.manualCommand === true) {
    try {
      registrations.push(
        await ctx.command.transform((editor) => {
          editor.add(command)
        }),
      )
    } catch (error) {
      // A host without a command registry still gets the tool and the pass.
      warn("the /skillstate command could not be registered: " + messageOf(error))
    }
  }

  return disposeAll
}

export default { id, setup } satisfies Plugin.Plugin
