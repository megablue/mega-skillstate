/**
 * Configuration: the defaults, and the strict resolver.
 *
 * The loader hands the plugin entry's `options` object straight to `setup`, with no
 * schema and no validation of its own. Every value is therefore checked here by hand,
 * and an unrecognised key is an error rather than a silently ignored typo: a context
 * policy that quietly keeps a default is worse than one that refuses to load.
 *
 * @module mega-skillstate/config
 */

import { existsSync, readFileSync } from "node:fs"
import { basename } from "node:path"

/** Package name; it is the plugin's id, and the label every message of its own is attributed to. */
export const PLUGIN = "mega-skillstate"

/**
 * The user-level config file's name, and the environment variable that points it
 * somewhere else.
 *
 * Both are plugin policy rather than host policy — they are what a user is told
 * to edit, whatever host the plugin runs under — so they live here beside the
 * defaults. Where the file *sits* (this host's own user configuration directory)
 * is the adapter's business: see `src/adapters/opencode/config.ts`.
 */
export const USER_CONFIG_FILENAME = "mega-skillstate.json"

/** The environment variable that points the user-level config file somewhere else. */
export const USER_CONFIG_ENV = "MEGA_SKILLSTATE_CONFIG"

/**
 * Everything the plugin reads, with the value used when the plugin entry says nothing.
 *
 * The defaults are deliberately conservative about cutting: `min` turns before
 * anything collapses, four turns kept verbatim, the first user instruction never
 * dropped. A too-aggressive cut that breaks a tool pair is a bug, not a tuning.
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  /** Turns a session must have before its superseded prefix is collapsed. */
  min: 4,
  /** Turns kept verbatim at the tail: the live tool loop's working memory. */
  keepRecentTurns: 4,
  /** Collapse the superseded prefix into the injected Σ message. */
  collapseOlder: true,
  /** Never drop the session's first real user message. */
  protectFirstUserMessage: true,
  /** Transform inside a subagent's own session. Off: a child's context is its own. */
  allowSubagentSessions: false,
  /** Keep `working.cwd`, `working.activeFiles`, `files` and `step` current from the recent window. */
  seedFromTools: true,
  /** Tools the deterministic seed reads, when `seedFromTools` is on. */
  trackTools: ["read", "edit", "write", "patch", "glob", "shell"] as readonly string[],
  /** Append a reminder when Σ has gone stale. */
  nudgeWhenStale: true,
  /** Steps since the last user message before the reminder is eligible. */
  staleAfter: 8,
  /** Register `/skillstate`. */
  manualCommand: true,
  /** Log the transform's decision. */
  debug: false,
}

/** The resolved policy: complete, deeply frozen, and safe to hold for a session's lifetime. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly min: number
  readonly keepRecentTurns: number
  readonly collapseOlder: boolean
  readonly protectFirstUserMessage: boolean
  readonly allowSubagentSessions: boolean
  readonly seedFromTools: boolean
  readonly trackTools: readonly string[]
  readonly nudgeWhenStale: boolean
  readonly staleAfter: number
  readonly manualCommand: boolean
  readonly debug: boolean
}

/** The two turn gates the transform reads together. */
export interface Thresholds {
  /** Turns that must exist before a prefix may be collapsed. */
  readonly minTurns: number
  /** Turns always kept verbatim, whatever the pressure. */
  readonly keepRecentTurns: number
}

const TOP_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/** Recursively freeze plain objects and arrays. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/** Deep-freeze a detached clone, so a caller cannot reach into resolved config. */
function frozen<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

/** Fail with a message that names the key and what was acceptable. */
function invalid(label: string, detail: string): never {
  throw new TypeError(`${PLUGIN} config: ${label} ${detail}`)
}

/** Require a boolean, because a quoted `"false"` must not read as enabled. */
function bool(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") invalid(label, `must be true or false, got ${JSON.stringify(value)}`)
  return value
}

/** Require an integer at or above a floor. */
function integer(value: unknown, label: string, fallback: number, min: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min) {
    invalid(label, `must be an integer >= ${min}, got ${JSON.stringify(value)}`)
  }
  return value as number
}

/** Require an array of non-empty strings. */
function strings(value: unknown, label: string, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    invalid(label, "must be an array of non-empty strings")
  }
  return [...(value as string[])]
}

/** Reject unknown keys so a misspelled option fails at load rather than silently. */
function keys(object: unknown, allowed: Set<string>, label: string): Record<string, unknown> {
  if (object === undefined) return {}
  if (object === null || typeof object !== "object" || Array.isArray(object)) {
    invalid(label, "must be an object")
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      invalid(`${label}.${key}`, `is not a key this plugin reads (known: ${[...allowed].join(", ")})`)
    }
  }
  return object as Record<string, unknown>
}

/** Read a JSON config file; a missing one is nothing at all, a malformed one is an error. */
function readJsonFile(file: string | undefined, label: string): unknown {
  if (file === undefined || !existsSync(file)) return undefined
  // A BOM is tolerated on purpose: an editor that writes one has still written JSON, and
  // the alternative is a plugin that refuses to load over an invisible byte.
  const text = readFileSync(file, "utf8").replace(/^﻿/, "")
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(label + " is not JSON: " + (error instanceof Error ? error.message : String(error)))
  }
}

/** A layer that is not a plain object is a mistake, not a silent empty layer. */
function objectLayer(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== "object" || Array.isArray(value)) invalid(label, "must be an object")
  return value as Record<string, unknown>
}

/**
 * The options the plugin runs with: the layers that apply, merged key by key.
 *
 * Measured on the reference plugin: an install that is only a directory under
 * `<configDir>/plugins/` is loaded with no `plugins` entry, and an entry naming a bare
 * package name hands it no options. So files are read here, and the ladder is the
 * specificity order — the host's own entry, the user-level file, then the copy an
 * install carries. A layer overwrites only the keys it sets; the rest fall through,
 * so a partial file is a valid file. A missing file is nothing at all; a malformed
 * one is an error, like every other configuration mistake.
 */
export function resolveOptions(hostOptions: unknown, optionsFile?: string, userFile?: string): unknown {
  const layers: Array<[unknown, string]> = [
    [readJsonFile(optionsFile, "the installed " + basename(optionsFile ?? "options.json")), "the installed options"],
    [readJsonFile(userFile, "the user-level " + basename(userFile ?? USER_CONFIG_FILENAME)), "the user-level config"],
  ]
  const merged: Record<string, unknown> = {}
  for (const [raw, label] of layers) {
    Object.assign(merged, objectLayer(raw, label))
  }
  // The host's entry applies only when it says something: an empty object is a host
  // that was handed nothing, not a statement that every default should win.
  const says = hostOptions !== null && typeof hostOptions === "object" && Object.keys(hostOptions).length > 0
  if (says) Object.assign(merged, objectLayer(hostOptions, "the host's options"))
  return merged
}

/**
 * Normalize the loader-supplied configuration.
 *
 * @param raw - the plugin entry's `options`, or nothing at all.
 * @returns a complete, deeply frozen configuration.
 * @throws when a key is unknown or a value has the wrong shape.
 */
export function resolveConfig(raw?: unknown): ResolvedConfig {
  const config = keys(raw ?? {}, TOP_KEYS, "config")
  const resolved: ResolvedConfig = {
    enabled: bool(config.enabled, "enabled", DEFAULT_CONFIG.enabled),
    min: integer(config.min, "min", DEFAULT_CONFIG.min, 1),
    keepRecentTurns: integer(config.keepRecentTurns, "keepRecentTurns", DEFAULT_CONFIG.keepRecentTurns, 0),
    collapseOlder: bool(config.collapseOlder, "collapseOlder", DEFAULT_CONFIG.collapseOlder),
    protectFirstUserMessage: bool(
      config.protectFirstUserMessage,
      "protectFirstUserMessage",
      DEFAULT_CONFIG.protectFirstUserMessage,
    ),
    allowSubagentSessions: bool(
      config.allowSubagentSessions,
      "allowSubagentSessions",
      DEFAULT_CONFIG.allowSubagentSessions,
    ),
    seedFromTools: bool(config.seedFromTools, "seedFromTools", DEFAULT_CONFIG.seedFromTools),
    trackTools: strings(config.trackTools, "trackTools", DEFAULT_CONFIG.trackTools),
    nudgeWhenStale: bool(config.nudgeWhenStale, "nudgeWhenStale", DEFAULT_CONFIG.nudgeWhenStale),
    staleAfter: integer(config.staleAfter, "staleAfter", DEFAULT_CONFIG.staleAfter, 1),
    manualCommand: bool(config.manualCommand, "manualCommand", DEFAULT_CONFIG.manualCommand),
    debug: bool(config.debug, "debug", DEFAULT_CONFIG.debug),
  }
  return frozen(resolved)
}

/**
 * The two turn gates, read together and clamped.
 *
 * They are a pair because the transform answers "may I collapse?" with both: a session
 * needs enough turns to *have* a superseded prefix — a two-turn conversation has none,
 * and Σ would be an empty message where the head already says everything — and a
 * recent window that stays whole. One function holds the clamping so the transform
 * never re-derives either gate from raw config.
 */
export function resolveThresholds(config: ResolvedConfig): Thresholds {
  return {
    minTurns: Math.max(1, Math.floor(config.min)),
    keepRecentTurns: Math.max(0, Math.floor(config.keepRecentTurns)),
  }
}
