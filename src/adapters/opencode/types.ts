/**
 * The OpenCode 2.0 shapes this plugin depends on — the adapter half.
 *
 * The vocabulary the core reads (`Message`, `ContentPart`, `SystemPart`,
 * `CollapsedSpan`, `CompactionEvent`, `StorageDomain`, `LastRequest`) is declared
 * in `src/core/types.ts` and re-exported here, so an adapter file keeps
 * importing one module. What is *below* is what only this host knows: the
 * registration envelope (`ctx.tool.transform`, `ctx.command.transform`,
 * `ctx.session.hook`) and the request shapes the loader hands `setup`.
 *
 * Recorded from the working reference plugin
 * (`~/.config/opencode/plugins/opencode-feature-map-as-context/src/types.ts`),
 * whose shapes were measured against a live `@opencode/plugin@2.0.26` host. They
 * are written out rather than imported so that the plugin carries no runtime
 * dependency on the host's own types, and so that every shape this plugin relies
 * on is visible in one file. `src/adapters/opencode/index.ts` asserts the
 * exported module against the host's own `Plugin.Plugin` type, so
 * `tsc --noEmit` is what notices when the loader contract drifts.
 *
 * @module mega-skillstate/adapters/opencode/types
 */

export * from "../../core/types.ts"

import type { Message, StorageDomain, SystemPart } from "../../core/types.ts"

/** What a hook registration hands back; disposing it unregisters. */
export interface Registration {
  dispose(): Promise<void>
}

/** A model the host knows about, as `model.transform` lists it. */
export interface ModelInfo {
  readonly id: any
  readonly providerID: any
  readonly limit?: { readonly context?: number }
  readonly [key: string]: any
}

/**
 * The `session.hook("context")` event: the request the host is about to send.
 *
 * Mutating `messages` or `system` in place is how a plugin changes what the model
 * sees; the durable transcript is never touched, so the transform has to be
 * re-applied on every request.
 */
export interface SessionContextEvent {
  readonly sessionID: any
  readonly agent: any
  readonly model: any
  system: SystemPart[]
  messages: Message[]
  /** Tool name to whatever the host attaches; the value shape is unmeasured. */
  tools: Record<string, any>
  readonly options?: Readonly<Record<string, any>>
  readonly [key: string]: any
}

// ---------------------------------------------------------------------------
// The plugin context
// ---------------------------------------------------------------------------

export interface SessionDomain {
  /**
   * Register a hook. The host ignores what the callback returns, so the mirror is
   * permissive: the `context` hook returns its report, which is what the smoke test
   * reads the measured numbers from.
   */
  hook(name: string, callback: (event: any) => Promise<unknown> | unknown): Promise<Registration>
  get(input: { sessionID: string }): Promise<{ readonly parentID?: unknown; readonly [key: string]: any }>
  context(input: { sessionID: string }): Promise<ReadonlyArray<any>>
  prompt(input: { sessionID: string; text: string; delivery?: unknown }): Promise<unknown>
  compact(input: { sessionID: string; delivery?: unknown }): Promise<unknown>
}

/** What the tool's `execute` receives. */
export interface ToolCallContext {
  readonly sessionID: any
  readonly agent: any
  readonly messageID: any
  readonly id: any
  readonly signal: AbortSignal
}

export interface ToolResult {
  content?: string | ReadonlyArray<{ type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }>
  output?: unknown
  metadata?: Record<string, unknown>
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly input: any
  /**
   * Required as soon as `execute` returns an `output`: measured against the CLI, a
   * result that declares output without a schema comes back to the model as
   * `Tool result declared output without an output schema` and the call is lost.
   */
  readonly output?: any
  readonly options?: { readonly codemode?: boolean; readonly pinned?: boolean; readonly permission?: string }
  execute(input: any, context: ToolCallContext): Promise<ToolResult>
}

/** Measured editor keys: `list`, `get`, `add`, `update`, `remove`. */
export interface ToolEditor {
  list(): ReadonlyArray<any>
  get(name: string): any
  add(tool: ToolDefinition): void
  readonly namespace?: any
  /** Measured but unused; `any` so the host's richer signature still fits this mirror. */
  readonly update?: any
  readonly remove?: any
}

export interface ToolDomain {
  transform(callback: (editor: ToolEditor) => void): Promise<Registration>
  list(): Promise<ReadonlyArray<{ readonly name: string }>>
}

export interface CommandInvocation {
  readonly sessionID: any
  readonly prompt: { readonly text?: string; readonly [key: string]: any }
  readonly delivery?: unknown
}

export interface CommandDefinition {
  readonly name: string
  readonly description?: string
  execute(invocation: CommandInvocation): Promise<void>
}

export interface CommandEditor {
  add(definition: CommandDefinition): void
}

export interface CommandDomain {
  transform(callback: (editor: CommandEditor) => void): Promise<Registration>
}

export interface ModelEditor {
  list(providerID?: string): ReadonlyArray<any>
  get(providerID: string, modelID: string): any
}

export interface ModelDomain {
  transform(callback: (editor: ModelEditor) => void): Promise<Registration>
}

/** Everything `setup` is handed. */
export interface PluginContext {
  readonly location: { readonly directory: string }
  readonly options: Readonly<Record<string, any>>
  readonly session: SessionDomain
  readonly tool: ToolDomain
  readonly command: CommandDomain
  readonly model: ModelDomain
  /**
   * Plugin-scoped durable key/value, namespaced by the plugin's id.
   *
   * Optional in this mirror on purpose: a host that has no storage seam is a host this
   * plugin runs in-memory on, and a plugin that cannot start without one loses the
   * session it was meant to help. Every use is guarded and degrades.
   */
  readonly storage?: StorageDomain
}
