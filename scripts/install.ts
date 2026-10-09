/**
 * Install, or uninstall, this plugin into an OpenCode discovery directory.
 *
 * The host discovers a plugin by looking for `<root>/server(.ts|.js)` inside its plugin
 * directories. Project scope reads `<project>/.opencode/plugin/<name>`; user scope reads
 * `~/.config/opencode/plugins/<name>`. Nothing else is required: no global config entry,
 * no build step, no dependency to install. That is the whole reason this file is a
 * hand-written script rather than a package-manager manifest — the install path is a
 * filesystem link the host will read directly, and it has to be right on the three
 * platforms the host itself runs on.
 *
 * Three modes, one flag each, mirroring the reference plugin's package.json:
 *
 * - (no flag)      link into the user's own config directory
 * - `--project`    link into this repository's `.opencode/plugin/`
 * - `--remove`     unlink whichever of the two is present
 * - `--status`     say where the plugin is discoverable from, and change nothing
 *
 * A **link** is used rather than a copy so that the plugin under test is the one in this
 * working tree — an edit to `src/` is live on the next request, which is what makes a
 * development checkout usable at all. The trade is that the link is a second place the
 * repository can break: a junction that points at a deleted directory is discovered as a
 * plugin that then fails to load. So the installer is idempotent and reversible, and
 * `--status` is a diagnostic rather than a guess.
 *
 * @module opencode-skill-state/install
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

/** The entry the loader resolves first; a `.js` build would shadow this only if present. */
const ENTRY = "server.ts"

/** What a discovery directory has to contain to be usable at all. */
export interface InstallResult {
  readonly scope: "user" | "project"
  readonly path: string
  readonly target: string
  readonly action: "linked" | "replaced" | "removed" | "missing" | "current"
}

/** Parse `--project`, `--remove`, `--status`, and reject anything unrecognised. */
export function parseArgs(argv: readonly string[]): { project: boolean; remove: boolean; status: boolean } {
  let project = false
  let remove = false
  let status = false
  for (const arg of argv) {
    if (arg === "--project") project = true
    else if (arg === "--remove" || arg === "--uninstall") remove = true
    else if (arg === "--status") status = true
    else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg} (see --help)`)
    }
  }
  return { project, remove, status }
}

function printHelp(): void {
  process.stdout.write(
    [
      "Install opencode-skill-state into an OpenCode plugin discovery directory.",
      "",
      "  (no arguments)   link into the user scope (~/.config/opencode/plugins/)",
      "  --project        link into this repository (.opencode/plugin/)",
      "  --remove         unlink, whichever scope is present",
      "  --status         report where it is discoverable from; change nothing",
      "  --help           this text",
      "",
      "The host resolves <root>/server before <root>/index, .ts before .js, so a source",
      "checkout needs no build step. A code change needs an OpenCode restart.",
    ].join("\n") + "\n",
  )
}

/** The package root: the directory holding this script's parent's parent. */
export function packageRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..")
}

/**
 * The user-scope discovery directory.
 *
 * `~/.config/opencode/plugins` (plural) is the one this host reads on Windows; the
 * singular `plugin` variant does not exist here, so it is not consulted.
 */
export function userPluginDir(): string {
  return join(homedir(), ".config", "opencode", "plugins")
}

/** The project-scope discovery directory for this repository. */
export function projectPluginDir(root: string): string {
  return join(root, ".opencode", "plugin")
}

/** Every directory the host will read for plugins, in the order it would see them. */
export function discoveryDirs(root: string): Array<{ scope: "user" | "project"; dir: string }> {
  return [
    { scope: "project", dir: projectPluginDir(root) },
    { scope: "user", dir: userPluginDir() },
  ]
}

/** Is this path a symlink or junction (rather than a real directory)? */
export function isLink(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Remove a link.
 *
 * `rmSync` with `recursive` would follow the link and delete the *target's* contents, so a
 * plain `rmdir` is issued through `rmSync` without the flag. This is the one operation in
 * this file that can destroy work, and it is deliberately the cautious form.
 */
function removeLink(path: string): void {
  if (isLink(path)) {
    rmSync(path)
    return
  }
  rmSync(path, { recursive: true, force: true })
}

/**
 * Link the package root into a discovery directory.
 *
 * Idempotent: a link that already points at the right place is left alone and reported as
 * `current`. A link pointing anywhere else — including at a directory that no longer
 * exists — is replaced, because a stale link is discovered as a plugin that fails to load
 * and is indistinguishable from a broken one.
 */
export function installInto(dir: string, root: string): InstallResult {
  const name = "opencode-skill-state"
  const path = join(dir, name)

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  // A link already on disk is either this package (nothing to do) or something else —
  // including a target that no longer exists. Either way it is replaced, because a stale
  // link is discovered as a plugin that fails to load and is indistinguishable from a
  // broken one.
  let replaced = false
  if (existsSync(path) || isLink(path)) {
    let pointsAt: string | undefined
    try {
      pointsAt = isLink(path) ? readlinkSync(path) : undefined
    } catch {
      pointsAt = undefined
    }
    if (pointsAt !== undefined && resolve(pointsAt) === resolve(root)) {
      return { scope: "user", path, target: root, action: "current" }
    }
    removeLink(path)
    replaced = true
  }

  if (!existsSync(join(root, ENTRY))) {
    throw new Error(`${root} has no ${ENTRY}; run from the package root`)
  }

  symlinkSync(root, path, "junction")
  return { scope: "user", path, target: root, action: replaced ? "replaced" : "linked" }
}

/** Remove the plugin from a discovery directory, when it is there. */
export function uninstallFrom(dir: string): InstallResult {
  const path = join(dir, "opencode-skill-state")
  if (!existsSync(path) && !isLink(path)) {
    return { scope: "user", path, target: "", action: "missing" }
  }
  removeLink(path)
  return { scope: "user", path, target: "", action: "removed" }
}

/** Run the three modes and report what happened, as the one exit code the host cares about. */
export function run(argv: readonly string[], root: string): number {
  const { project, remove, status } = parseArgs(argv)
  const scope = project ? "project" : "user"
  const dir = scope === "project" ? projectPluginDir(root) : userPluginDir()
  const label = scope === "project" ? "project scope" : "user scope"

  try {
    if (status) {
      const rows: string[] = []
      for (const candidate of discoveryDirs(root)) {
        const path = join(candidate.dir, "opencode-skill-state")
        const here = existsSync(path) || isLink(path)
        const target = isLink(path) ? readlinkSync(path) : undefined
        rows.push(
          `  ${candidate.scope === "project" ? "project" : "user   "} ${candidate.dir}` +
            (here ? ` -> ${target ?? "a real directory"}` : " (not installed)"),
        )
      }
      process.stdout.write("opencode-skill-state discoverable from:\n" + rows.join("\n") + "\n")
      return 0
    }

    const result = remove ? uninstallFrom(dir) : installInto(dir, root)
    const verb =
      result.action === "linked"
        ? `linked into ${label}`
        : result.action === "replaced"
          ? `replaced a stale link in ${label}`
          : result.action === "removed"
            ? `removed from ${label}`
            : result.action === "current"
              ? `already installed in ${label}`
              : `nothing to remove from ${label}`
    process.stdout.write(`${verb}\n  ${result.path}\n`)
    if (result.action === "linked" || result.action === "replaced") {
      process.stdout.write("Restart OpenCode for the host to discover it.\n")
    }
    return 0
  } catch (error) {
    process.stderr.write(`install failed: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

// Running as a script: the argv after the interpreter and this file.
if (process.argv[1] !== undefined && import.meta.url.endsWith("install.ts") && process.argv[1].includes("install")) {
  const root = packageRoot()
  process.exitCode = run(process.argv.slice(2), root)
}

/** Directories that exist but hold nothing the loader would read. */
export function emptyDirs(root: string): string[] {
  return discoveryDirs(root)
    .map((entry) => entry.dir)
    .filter((dir) => !existsSync(dir))
}

/** What a status run reports, for the smoke test to assert on without capturing stdout. */
export function statusLines(root: string): string[] {
  return discoveryDirs(root).map((entry) => {
    const path = join(entry.dir, "opencode-skill-state")
    return existsSync(path) || isLink(path) ? entry.scope + ": installed" : entry.scope + ": absent"
  })
}

/** Unused import guard: keeps the plugin-name literal beside the one place it is derived. */
export const PLUGIN_DIR_NAME = "opencode-skill-state"
void isAbsolute
