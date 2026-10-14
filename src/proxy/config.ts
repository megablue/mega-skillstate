/**
 * The daemon's own configuration: what it listens on, where it forwards, which
 * wire it speaks, and the collapse policy it runs.
 *
 * **Why this file exists rather than being folded into `server.ts`.** The
 * daemon is a process an operator launches, not a plugin a host loads, so it
 * has settings the core has never heard of: a port, a bind address, an
 * upstream, a directory. Those are this module's, and this module's alone. What
 * it shares with the core is the collapse policy, and that is shared by
 * *delegation* rather than by duplication — see the split below.
 *
 * **The split, and why it is not just convenience.** The core's
 * `resolveConfig` is strict: an unknown key is a `TypeError` rather than a
 * silently ignored default, because a context policy that quietly keeps its
 * default is worse than one that refuses to load. That strictness is the
 * behaviour a daemon should inherit unchanged, so the daemon's keys are peeled
 * off here and the remainder is handed to the core untouched. The two sets
 * overlap in exactly one place — `debug` — and the overlap is resolved by
 * leaving that key entirely to the core rather than reading it twice.
 *
 * **Two keys have no default on purpose.** `upstream` and `codec`. A daemon
 * that forwards nowhere, or one that forwards the wrong wire, is a mistake
 * rather than a tuning: the first is a process that cannot answer, and the
 * second is worse — it decodes Anthropic's `content` blocks as Responses
 * `output_text` and sends the model an empty conversation, with nothing
 * anywhere reporting a failure. Both must therefore be named.
 *
 * **`dir` is optional, and that is a real choice.** With one, Σ survives the
 * process, which is the whole point of the durable store. Without one the
 * daemon still runs and still collapses, in memory, and a restart resumes
 * empty — the degraded mode every host without a storage seam already gets.
 * It is allowed because it is honest, and it is visible because the log line
 * names it at construction.
 *
 * **`host` defaults to loopback.** The daemon holds no credentials of its own
 * and forwards the caller's, so binding it anywhere else exposes a
 * credential-forwarding endpoint to the network it did not ask to be exposed.
 * An operator who does want that has to say so in a file, which is a decision
 * rather than an accident.
 *
 * @module mega-skillstate/proxy-config
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

import { DEFAULT_CONFIG, PLUGIN, resolveConfig } from "../core/config.ts"
import type { ResolvedConfig } from "../core/config.ts"
import type { Codec } from "../core/ports.ts"
import { codec as anthropicCodec } from "./codec-anthropic.ts"
import { codec as openaiCodec } from "./codec-openai.ts"

/** Where a refusal goes, so it is visible rather than silent. */
export type ProxyLog = (line: string) => void

/** The conventional place this daemon's config file sits, absent an env override. */
export const PROXY_CONFIG_ENV = "MEGA_SKILLSTATE_PROXY_CONFIG"

/** The port a daemon listens on when nothing says otherwise. */
export const DEFAULT_PORT = 8787

/** The interface a daemon binds when nothing says otherwise. */
const DEFAULT_HOST = "127.0.0.1"

/** The session an unidentifiable request is filed under. */
const DEFAULT_FALLBACK_SESSION = "shared"

/** Which wire the daemon speaks. Named rather than inferred from the upstream. */
export type ProxyCodecName = "anthropic" | "openai"

/** The keys that are this module's; everything else belongs to the core. */
const DAEMON_KEYS = new Set(["port", "host", "upstream", "codec", "dir", "fallbackSession"])

/**
 * Every key a daemon config may carry: its own, plus the core's collapse keys.
 *
 * Built from `DEFAULT_CONFIG` rather than restated, so a key the core adds is
 * admitted here the moment the core adds it. Restating would mean a new core
 * key is a config error on a daemon, which is a failure nobody would trace back
 * to a list in a file they were not editing.
 */
const ALLOWED = new Set([...DAEMON_KEYS, ...Object.keys(DEFAULT_CONFIG)])

/** The codec each name selects. A new wire is a new entry and nothing else. */
function codecFor(name: ProxyCodecName): Codec {
  return name === "anthropic" ? anthropicCodec : openaiCodec
}

/** What a daemon is configured with: complete, frozen, and safe to hold for the process's life. */
export interface ProxyConfig {
  /** The port to listen on. `0` lets the OS choose, and the bound port is read off `address()`. */
  readonly port: number
  /** The interface to bind. Loopback unless an operator says otherwise. */
  readonly host: string
  /** The provider base URL every request is forwarded to. */
  readonly upstream: URL
  /** Which wire it speaks — chosen, never guessed from the upstream. */
  readonly codec: ProxyCodecName
  /** Where Σ lives, when it survives the process at all. */
  readonly dir: string | undefined
  /** The session a request with no usable hint is filed under. */
  readonly fallbackSession: string
  /** The collapse policy: the core's own resolution, untouched. */
  readonly policy: ResolvedConfig
  /** The `debug` key, which the core owns and this module reads. */
  readonly debug: boolean
}

/** Fail with a message that names the key and what was acceptable, as the core does. */
function invalid(label: string, detail: string): never {
  throw new TypeError(`${PLUGIN} daemon config: ${label} ${detail}`)
}

function int(value: unknown, label: string, fallback: number, min: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min) {
    invalid(label, `must be an integer >= ${min}, got ${JSON.stringify(value)}`)
  }
  return value as number
}

function text(value: unknown, label: string, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== "string" || value.trim() === "") invalid(label, "must be a non-empty string")
  return value
}

function codecName(value: unknown, label: string): ProxyCodecName {
  if (value !== "anthropic" && value !== "openai") {
    invalid(label, `must be "anthropic" or "openai", got ${JSON.stringify(value)}`)
  }
  return value
}

function url(value: unknown, label: string): URL {
  if (typeof value !== "string") {
    invalid(label, `is required and must be an absolute http(s) URL, got ${value === undefined ? "nothing" : JSON.stringify(value)}`)
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      invalid(label, `must be an http or https URL, got ${JSON.stringify(value)}`)
    }
    return parsed
  } catch {
    // `new URL` throws on anything it cannot parse; the message above is what
    // the key was actually missing, so it is the one an operator needs.
    invalid(label, `is not a URL this daemon can forward to, got ${JSON.stringify(value)}`)
  }
}

/** Read a JSON config file; a missing one is nothing at all, a malformed one is an error. */
function readJsonFile(file: string | undefined, label: string): unknown {
  if (file === undefined || !existsSync(file)) return undefined
  // A BOM is tolerated, exactly as the core tolerates it: an editor that writes
  // one has still written JSON.
  const text = readFileSync(file, "utf8").replace(/^﻿/, "")
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(label + " is not JSON: " + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * The layered options a daemon runs with: the config file, then what overrides it.
 *
 * The order is the specificity order, the same one the core's `resolveOptions`
 * uses — a file is what an operator leaves behind, and anything layered after it
 * is the more specific statement (an environment variable, a launch argument).
 * A partial layer is valid, because a daemon that only wants to change its port
 * should not have to restate its upstream.
 */
export function resolveProxyOptions(overrides: unknown, configFile?: string): unknown {
  const merged: Record<string, unknown> = {}
  const fromFile = readJsonFile(configFile, "the daemon config " + basename(configFile ?? "proxy.json"))
  if (fromFile !== null && fromFile !== undefined) {
    if (typeof fromFile !== "object" || Array.isArray(fromFile)) {
      invalid("the daemon config", "must be an object")
    }
    Object.assign(merged, fromFile as Record<string, unknown>)
  }
  const says = overrides !== null && typeof overrides === "object" && Object.keys(overrides).length > 0
  if (says) {
    if (Array.isArray(overrides)) invalid("the daemon options", "must be an object")
    Object.assign(merged, overrides as Record<string, unknown>)
  }
  return merged
}

/** Where this daemon's config file conventionally lives. */
export function proxyConfigPath(): string {
  return join(homedir(), ".config", PLUGIN, "proxy.json")
}

/**
 * Build the codec for a config, so a mismatch cannot be assembled by hand.
 *
 * The name is the config's and the mapping is here, which is deliberately not a
 * second decision point: a caller holding a `ProxyConfig` cannot pair an
 * Anthropic upstream with the Responses codec unless the config itself is
 * wrong, and the config will not validate a name it does not know.
 */
export function codecOf(config: ProxyConfig): Codec {
  return codecFor(config.codec)
}

/**
 * Resolve the daemon's configuration, folding in the core's collapse policy.
 *
 * @param raw - the daemon's own keys and the core's collapse keys together.
 * @returns a complete, deeply frozen configuration.
 * @throws when a key is unknown, a required key is missing, or a value has the
 *         wrong shape — the same contract `resolveConfig` makes, extended.
 */
export function resolveProxyConfig(raw?: unknown): ProxyConfig {
  const source = raw ?? {}
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    invalid("config", "must be an object")
  }
  const flat = source as Record<string, unknown>

  // Unknown keys are named before anything else happens, so a typo is reported
  // against the whole daemon key set rather than being handed to the core,
  // which would call it unknown to a file that is not the daemon's.
  for (const key of Object.keys(flat)) {
    if (!ALLOWED.has(key)) invalid(key, `is not a key this daemon reads (known: ${[...ALLOWED].sort().join(", ")})`)
  }

  // The daemon's keys, then the remainder for the core. `debug` is in the
  // remainder and never read here, so the strictness applies to it in one place.
  const own: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(flat)) {
    if (DAEMON_KEYS.has(key)) own[key] = value
    else rest[key] = value
  }

  const upstream = url(own["upstream"], "upstream")
  const codec = codecName(own["codec"], "codec")
  const dir = own["dir"]
  if (dir !== undefined && (typeof dir !== "string" || dir.trim() === "")) {
    invalid("dir", "must be a non-empty path, or left out entirely for a memory-only daemon")
  }

  const policy = resolveConfig(rest)
  const resolved: ProxyConfig = {
    port: int(own["port"], "port", DEFAULT_PORT, 0),
    host: text(own["host"], "host", DEFAULT_HOST),
    upstream,
    codec,
    dir: dir as string | undefined,
    fallbackSession: text(own["fallbackSession"], "fallbackSession", DEFAULT_FALLBACK_SESSION),
    policy,
    debug: policy.debug,
  }
  return deepFreeze(resolved)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}
