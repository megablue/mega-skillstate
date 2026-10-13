/**
 * The Pi host shapes this plugin depends on — the adapter half.
 *
 * The vocabulary the core reads (`Message`, `ContentPart`, `SystemPart`,
 * `CollapsedSpan`, `CompactionEvent`, `StorageDomain`, `LastRequest`) is declared in
 * `src/core/types.ts` and re-exported here, so an adapter file keeps importing one
 * module. What is *below* is what only this host knows.
 *
 * Hand-written rather than imported, exactly as `src/adapters/opencode/types.ts` is: the
 * shapes were measured against the installed `@earendil-works/pi-coding-agent` (the
 * `dist/core/extensions/types.d.ts` surface and the `examples/extensions/` reference
 * corpus), and are written out so this plugin carries no runtime dependency on the
 * host's own packages. A host we have not measured is a host we do not guess at — every
 * field below was read from the installed `.d.ts`, not inferred from a summary.
 *
 * One deliberate omission: **TypeBox is not mirrored as an import.** Pi's
 * `ToolDefinition` is generic over a `TSchema` and its `execute` receives
 * `Static<TParams>`, both of which come from packages the host provides. This plugin
 * declares the structural minimum instead, because the only schema it ever passes is its
 * own plain-JSON `TOOL_INPUT` — so the mirror stays honest without reaching for a
 * dependency the host may not hand us.
 *
 * @module mega-skillstate/adapters/pi/types
 */

export * from "../../core/types.ts"

import type { Message, StorageDomain, SystemPart } from "../../core/types.ts"

// ---------------------------------------------------------------------------
// The tool surface
// ---------------------------------------------------------------------------

/**
 * How the model reaches a tool.
 *
 * Measured values: `direct` activates on registration and is the analogue of
 * OpenCode's `codemode: false` — a registered tool that is also an *offered* tool. The
 * others are measured but unused here: `model-only` never enters codemode, `codemode` and
 * `deferred` are reached through the wrapper rather than by name, and `hidden` is a
 * declaration the model never sees.
 */
export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden"

/** What a tool result carries: rendered text for the model, and a structured record. */
export interface PiToolResult<TDetails = unknown> {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
  readonly details?: TDetails
  readonly structuredContent?: unknown
}

/**
 * The tool definition, as `registerTool` reads it.
 *
 * Two fields have no OpenCode equivalent and are worth naming: `label` is a
 * human-readable string for the UI (not a description — the model reads `description`),
 * and `parameters` is a TypeBox schema rather than a JSON Schema object. What this plugin
 * passes in `parameters` is its own plain-JSON `TOOL_INPUT` from
 * `src/core/skill-state.ts`, which is structurally a schema object and satisfies the
 * mirror without the host's generics.
 */
export interface PiToolDefinition<TDetails = unknown> {
  readonly name: string
  /** Required by the host: a UI label, not a description. */
  readonly label: string
  readonly description: string
  /**
   * The parameter schema. Typed `unknown` on purpose: the host wants a TypeBox `TSchema`
   * and this plugin hands it its own plain-JSON `TOOL_INPUT`. The parameter schema's
   * `type` union is a JSON-Schema spelling that is only honoured on a real host, so this
   * is the one place the fake host deliberately stays weaker than the real one.
   */
  readonly parameters: unknown
  readonly outputSchema?: unknown
  /** Defaults to `"direct"`, which is what this plugin wants. */
  readonly exposure?: ToolExposure
  /** Defaults to `true` for `direct` tools, which is what this plugin wants. */
  readonly defaultActive?: boolean
  execute(
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionToolContext,
  ): Promise<PiToolResult<TDetails>>
}

// ---------------------------------------------------------------------------
// The extension context
// ---------------------------------------------------------------------------

/** The host's plugin context, as one tool or command sees it. */
export interface ExtensionContext {
  /** Which surface the extension is running in; guards whether `ui` can answer. */
  readonly mode: string
  /** Whether a UI exists to answer through. */
  readonly hasUI: boolean
  readonly sessionManager: ExtensionSessionManager
  readonly modelRegistry: unknown
  readonly signal: AbortSignal
  readonly ui: ExtensionUISurface
  /** Process-level handles, including the host's own shutdown. */
  readonly ctx: { readonly shutdown?: () => unknown }
  readonly extensions: unknown
  /** Subscribe to session events; the return value unsubscribes. */
  subscribe(event: string, handler: (event: unknown) => unknown): unknown
}

/** What the tool's `execute` is handed: its own context, plus the call's identity. */
export interface ExtensionToolContext extends ExtensionContext {
  readonly sessionId: string
  readonly toolCallId?: string
  readonly abortSignal: AbortSignal
}

/** What a command's handler is handed. */
export interface ExtensionCommandContext extends ExtensionContext {
  readonly sessionId: string
}

/** The UI, as far as this plugin reaches. */
export interface ExtensionUISurface {
  /** The reply channel: a note the user sees, which does not trigger a turn. */
  notify(message: string, level?: "info" | "warn" | "error" | "success"): unknown
}

/** The session manager, as far as this plugin reaches. */
export interface ExtensionSessionManager {
  /**
   * The branch, in order — the durable transcript this session is carrying.
   *
   * This is what a resumed session is rebuilt from, and therefore what makes a durable
   * read resume-safe: `appendEntry` writes are excluded from the model's context, but
   * they are present here, so a session that restarts reconstructs its Σ instead of
   * starting empty.
   */
  getBranch?(): ReadonlyArray<unknown>
  getSessionId?(): unknown
  getCurrentSessionId?(): unknown
}

/** The command registration, as `registerCommand` reads it. */
export interface PiCommandDefinition {
  readonly description?: string
  /** The host hands a **string** argument where OpenCode hands an invocation object. */
  handler(args: string, ctx: ExtensionCommandContext): Promise<void> | void
}

/**
 * The one object an extension factory is handed.
 *
 * `registerTool` and `registerCommand` return `void` — unlike OpenCode's hooks, which
 * hand back a `Registration` that unregisters — so the adapter's own bookkeeping is what
 * has to be disposed, not the host's.
 */
export interface ExtensionAPI {
  /**
   * Subscribe to a session event; the return value unsubscribes.
   * @returns an unsubscribe, per the extension API.
   */
  on(event: string, handler: (event: any) => unknown): (() => unknown) | undefined
  registerTool(definition: PiToolDefinition<any>): void
  registerCommand(name: string, definition: PiCommandDefinition): void
  /**
   * A durable entry, excluded from the model's context.
   *
   * This is the Storage port's write, and it is *not* this plugin's own namespace: the
   * key and the payload are chosen here, so a session's Σ survives a restart and is
   * reconstructible from `getBranch()`.
   */
  appendEntry(customType: string, data: unknown): unknown
  sendMessage?(message: unknown): unknown
}

// ---------------------------------------------------------------------------
// The events this plugin rides
// ---------------------------------------------------------------------------

/**
 * The `context` event: the payload the host is about to send, minus the system prompt.
 *
 * Measured: `messages` excludes the prompt and the tool listing, and the host *restores*
 * that state after the handler returns — so a handler cannot drop the prompt by
 * accident, and the collapse seam is exactly the message array. The heavier
 * `context_with_system` event owns the whole transcript and is deliberately NOT used.
 */
export interface ContextEvent {
  readonly type: "context"
  readonly messages: Message[]
  readonly system?: ReadonlyArray<SystemPart>
  readonly model?: unknown
  readonly [key: string]: any
}

/** What the `before_agent_start` hook is handed. */
export interface BeforeAgentStartEvent {
  readonly type: "before_agent_start"
  readonly sessionId?: string
  /**
   * The system-prompt options this turn was built from.
   *
   * This is where the standing policy push lands on this host: OpenCode appends to an
   * `event.system` array, and Pi has no such array on this event, so the adapter adds a
   * section through this object instead. Its exact shape is owned by the host and is
   * reached structurally.
   */
  readonly systemPromptOptions: Record<string, any>
  readonly [key: string]: any
}

/** What the `session_before_compact` hook is handed, and what it may answer. */
export interface CompactionEvent {
  readonly type: "session_before_compact"
  readonly sessionId?: string
  readonly messages?: ReadonlyArray<Message>
  readonly system?: ReadonlyArray<SystemPart>
  readonly model?: unknown
  readonly [key: string]: any
}

/** The durable payload this plugin keeps in an appended entry. */
export interface PiStateEntry {
  readonly state: Record<string, unknown>
  readonly collapsed?: { readonly from: number; readonly to: number } | undefined
  readonly summary?: string | undefined
}

/** What a session's durable Σ looks like as it is reconstructed from the branch. */
export interface PiRestoredState {
  /** Σ as the model last committed it, or `undefined` when nothing was written. */
  readonly state: Record<string, unknown> | undefined
  readonly collapsed: { readonly from: number; readonly to: number } | undefined
  readonly summary: string | undefined
}

/**
 * A Storage port implementation, as the host-shaped half provides it.
 *
 * The port itself is `ports.Storage` and the alias `core/types.ts` publishes as
 * `StorageDomain`; this is the Pi half that satisfies it. `get`/`set` are the whole
 * contract here, because the durable read is reconstructed from the branch rather than
 * served by a keyed lookup.
 */
export interface PiStorage extends StorageDomain {}
