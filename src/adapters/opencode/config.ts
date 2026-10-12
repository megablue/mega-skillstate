/**
 * The host-shaped half of configuration: where *this* host keeps its user file.
 *
 * Everything a plugin can decide for itself — the defaults, the strict
 * validation, the layer merge — lives in `src/core/config.ts`, which is
 * host-free and shared by every adapter. What cannot move is where the
 * user-level file sits: it lives in the directory this host already keeps its
 * own user configuration in (`~/.config/opencode`, beside `opencode.json`),
 * and a second adapter would put it somewhere else.
 *
 * The environment override (`MEGA_SKILLSTATE_CONFIG`) exists for tests, which
 * must never write to a real home, and for a user who wants the file somewhere
 * else entirely. It is read when `setup` runs, not at import, so a test can
 * redirect per call.
 *
 * @module mega-skillstate/adapters/opencode/config
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { DEFAULT_CONFIG, USER_CONFIG_ENV, USER_CONFIG_FILENAME } from "../../core/config.ts"

export * from "../../core/config.ts"

/**
 * The user-level config file: the host's own user directory, one plugin-named file in it.
 *
 * The directory is the one this host keeps its user configuration in — the same one
 * `opencode.json` and the other per-plugin files live in — so the file sits where a
 * user already looks for settings.
 */
export function userConfigPath(): string {
  const override = process.env[USER_CONFIG_ENV]
  if (typeof override === "string" && override.length > 0) return override
  return join(homedir(), ".config", "opencode", USER_CONFIG_FILENAME)
}

/**
 * The user-level config file, written with every default when it does not exist yet.
 *
 * A user who has never seen one has nothing to edit it from, so a first run writes the
 * defaults there, pretty-printed — and never again: a file that exists is the user's
 * own, edits included, and is left exactly as it is. A write that fails is the
 * caller's to report; this function throws rather than swallowing it.
 *
 * @param userFile - the file to write; defaults to `userConfigPath()`.
 * @returns whether the file was created (`false` when it already existed).
 * @throws when the directory or the file cannot be written.
 */
export function ensureUserConfig(userFile?: string): boolean {
  const file = userFile ?? userConfigPath()
  if (existsSync(file)) return false
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8")
  return true
}
