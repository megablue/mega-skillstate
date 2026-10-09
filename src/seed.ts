/**
 * The deterministic seed: keep Σ's floor current from the recent window alone.
 *
 * The model writes Σ by calling `skill_state`, and that is the only channel that knows
 * *why* anything happened. But a model that is busy working does not always spend a
 * call on bookkeeping, and a Σ that says nothing about the file it is currently
 * editing is a Σ the model learns to ignore. So the runtime reads the window and keeps
 * the floor honest: which files were touched, from where, and how far along the work is.
 *
 * Two rules keep that from ever fighting the model:
 *
 * 1. **Only what a tracked tool call names counts.** Nothing is inferred from prose, a
 *    symbol name, or a guess; a path invented from a vague match would put a file in
 *    Σ that was never opened, which is worse than a missing one.
 * 2. **A seed only fills a hole** (`StateRecord.seed`). Once the model has said
 *    anything about a key, its word is final.
 *
 * @module opencode-skill-state/seed
 */

import { isPlainObject, type Sigma } from "./schema.ts"
import { parseArguments, toolCalls, toolResults, valueText } from "./view.ts"
import type { Message } from "./types.ts"

/** What one tracked tool call contributes to Σ's floor. */
export interface SeedHints {
  /** path -> what we did there. */
  readonly files: Sigma
  /** `{ cwd, branch, activeFiles }`, each only when something in the window said it. */
  readonly working: Sigma
  /** Tracked calls seen in the window, as a step count. */
  readonly step: number
}

/** Argument keys that name a file outright. */
const FILE_ARG_KEYS = ["file_path", "filePath", "notebook_path", "notebookPath", "filename"]

/** What each tracked tool added to Σ's account of a path. */
const VERBS: Readonly<Record<string, string>> = {
  read: "read",
  edit: "edited",
  write: "written",
  patch: "patched",
  glob: "listed",
  shell: "run from the shell",
}

/** A `cd` in a shell command, whether the host handed an object or a command string. */
const CD_COMMAND = /(?:^|&&|\|\||;)\s*cd\s+("?)([^"'\s&|;]+)\1/

/** Argument keys that hold a command a shell was handed. */
const COMMAND_ARG_KEYS = ["command", "cmd", "script"]

/** One path spelling, so two calls to the same file compare equal. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "")
}

/** Could this token from a tool result be a path? */
function looksLikePath(token: string): boolean {
  if (token.length === 0 || token.length > 260) return false
  if (/\s/.test(token)) return false
  return /[/\\]/.test(token) || /\.[A-Za-z0-9]{1,10}$/.test(token)
}

/**
 * Read the messages it is given for what Σ's floor should say.
 *
 * This is the scan both callers use, and the only thing that distinguishes them is what
 * they hand it: the transform hands the window that survives a collapse, the compaction
 * sweep hands the whole transcript. Same rules either way — only what a tracked tool call
 * names counts, and a seed only ever fills a hole.
 *
 * @param messages - the payload as the host wrote it.
 * @param trackTools - the tool names worth reading.
 * @returns hints for `working`, `files` and `step`; each is empty when nothing said it.
 */
export function seedHintsFromMessages(messages: ReadonlyArray<Message>, trackTools: ReadonlyArray<string>): SeedHints {
  const tracked = new Set(trackTools)
  const files = new Map<string, string>()
  const names = new Map<string, string>()
  let cwd: string | undefined
  let calls = 0

  // Two passes, because a result has to be readable before its call's tool is known.
  for (const message of messages) {
    for (const part of toolCalls(message)) {
      if (typeof part.id === "string") names.set(part.id, part.name)
    }
  }

  for (const message of messages) {
    for (const part of toolCalls(message)) {
      if (!tracked.has(part.name)) continue
      calls += 1
      const input = parseArguments(part)
      const args = isPlainObject(input) ? input : {}
      for (const key of FILE_ARG_KEYS) {
        const path = args[key]
        if (typeof path === "string" && path.length > 0) {
          files.set(normalizePath(path), VERBS[part.name] ?? "touched")
        }
      }
      const where = args["cwd"]
      if (typeof where === "string" && where.length > 0) cwd = where
      for (const key of COMMAND_ARG_KEYS) {
        const command = args[key]
        if (typeof command !== "string") continue
        const found = CD_COMMAND.exec(command)
        if (found?.[2] !== undefined) cwd = found[2]
      }
    }
    for (const part of toolResults(message)) {
      const name = names.get(part.id)
      // Only a listing names paths wholesale; a search's matches are evidence, not a
      // record of what was opened.
      if (name !== "glob") continue
      for (const line of valueText(part).split(/\r?\n/)) {
        const path = line.trim()
        if (looksLikePath(path)) files.set(normalizePath(path), VERBS["glob"])
      }
    }
  }

  const working: Sigma = {}
  if (cwd !== undefined) working["cwd"] = cwd
  if (files.size > 0) working["activeFiles"] = [...files.keys()].sort()

  return { files: Object.fromEntries([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))), working, step: calls }
}

/**
 * The transform's window scan.
 *
 * The transform passes exactly the messages that survive the collapse, so Σ's floor is
 * measured against the window the model will still be able to read — not against the
 * prefix that is about to be folded into Σ.
 */
export function seedHints(messages: ReadonlyArray<Message>, trackTools: ReadonlyArray<string>): SeedHints {
  return seedHintsFromMessages(messages, trackTools)
}

/** Nothing in the window said anything: the seed stays out of Σ entirely. */
export const EMPTY_HINTS: SeedHints = { files: {}, working: {}, step: 0 }
