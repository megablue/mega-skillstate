/**
 * Install, or uninstall, this plugin into an OpenCode discovery directory.
 *
 * The host discovers a plugin by looking for `<root>/server(.ts|.js)` inside its plugin
 * directories. Project scope reads `<project>/.opencode/plugin/<name>`; user scope reads
 * `~/.config/opencode/plugins/<name>`. Nothing else is required: no global config entry,
 * no build step, no dependency to install — the package has no runtime dependencies, so
 * a copy needs no `node_modules`, and the host loads the TypeScript source directly. That
 * is the whole reason this file is a hand-written script rather than a package-manager
 * job: the install path is a directory of files the host reads directly, and it has to be
 * right on the three platforms the host itself runs on.
 *
 * The install is a **copy**, not a link. The host imports the plugin's module graph once
 * per process, so a link buys nothing — a code change needs an OpenCode restart whether
 * the plugin is a link or a copy ("A code change needs an OpenCode restart", as the help
 * text below has always said). What a copy does buy: the install is a real directory in
 * the same shape a user gets (the reference plugin ships this way), it cannot break
 * because a working tree moved, and it can be *compared* against the repository, so a
 * stale install is diagnosable drift instead of a plugin that quietly runs old code. An
 * earlier version linked instead; those junctions are retired — the first install after
 * this change replaces them with a copy, leaving the target's contents alone.
 *
 * Three modes, one flag each:
 *
 * - (no flag)      install into the user's own config directory
 * - `--project`    install into this repository's `.opencode/plugin/`
 * - `--remove`     remove whichever of the two is present
 * - `--status`     say where the plugin is discoverable from, and whether the copy has
 *                  drifted from this working tree; change nothing
 *
 * The installer is idempotent: a copy that matches the shipped set byte for byte is left
 * alone and reported as `current` — not rewritten. A copy that has drifted is synced on
 * the next install, because a reinstall is an upgrade. What a *user* owns lives outside
 * the install (`~/.config/opencode/mega-skillstate.json`), so syncing the shipped set
 * destroys nothing of theirs.
 *
 * @module mega-skillstate/install
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createHash } from "node:crypto"

/** The entry the loader resolves first; a `.js` build would shadow this only if present. */
const ENTRY = "server.ts"

/**
 * The package's own name, read from its manifest rather than written down again.
 *
 * The discovery directory name, the plugin's `id`, and the label its messages are
 * attributed to are all this one string. Writing it a second time here — or a
 * fourth, which is what it was — is how a rename ships half-applied, and a copy
 * under the wrong name is a plugin the host never discovers. This is the single
 * reader; a rename edits `package.json`.
 */
function packageName(root: string): string {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error(`${root}/package.json has no name`)
  }
  return manifest.name
}

/**
 * What a discovery directory has to contain to be usable at all.
 *
 * `action` is the mode of the change, `changed` the number of files written (0 for a
 * no-op or a removal), and `scope` is propagated rather than hardcoded, so a project-scope
 * result never claims to be the user's.
 */
export interface InstallResult {
  readonly scope: "user" | "project"
  readonly path: string
  readonly target: string
  readonly action: "installed" | "updated" | "replaced" | "removed" | "missing" | "current"
  readonly changed: number
}

/** The ways an installed copy can differ from the repository it was copied from. */
export interface Drift {
  readonly missing: string[]
  readonly changed: string[]
  readonly extra: string[]
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
      "Install mega-skillstate into an OpenCode plugin discovery directory.",
      "",
      "  (no arguments)   copy into the user scope (~/.config/opencode/plugins/)",
      "  --project        copy into this repository (.opencode/plugin/)",
      "  --remove         remove, whichever scope is present",
      "  --status         report where it is discoverable from, and whether the copy",
      "                   has drifted from the repository; change nothing",
      "  --help           this text",
      "",
      "The install is a copy of the shippable set (the manifest's files[] plus package.json",
      "itself, which the ESM load needs). No build step and no node_modules: the host",
      "resolves <root>/server before <root>/index, .ts before .js, and loads the TypeScript",
      "source directly. A code change needs an OpenCode restart.",
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
 * The files that ship in an install, as manifest-relative paths.
 *
 * The list is read from `package.json`'s `files[]` — the same field `npm pack` uses — with
 * `package.json` itself always added, because the copy needs it: `"type": "module"` is what
 * makes the host load `.ts` as ESM, and a copy without its manifest is a plugin that fails
 * to load. Every entry is checked against the working tree, so a manifest that lists a
 * missing file is an error at install time rather than a copy that is silently incomplete
 * — the class of bug the old hand-written manifest had.
 */
export function shippableFiles(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: unknown }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${root}/package.json lists no files to ship; fill in its files[] array`)
  }
  const entries = manifest.files.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
  if (!entries.includes("package.json")) entries.push("package.json")
  for (const entry of entries) {
    if (!existsSync(join(root, entry))) {
      throw new Error(`package.json files[] lists ${entry}, but ${root} has no ${entry}`)
    }
  }
  return entries
}

/** Every leaf file under a directory, as forward-slashed paths relative to it. */
function fileTree(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : prefix + "/" + entry.name
      if (entry.isDirectory()) walk(join(current, entry.name), relative)
      else out.push(relative)
    }
  }
  walk(dir, "")
  return out
}

/** A file's content hash, so drift is measured on bytes rather than timestamps. */
function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/** How many files a directory holds, node_modules excluded — copied trees carry none. */
function countFiles(dir: string): number {
  return fileTree(dir).filter((relative) => !relative.startsWith("node_modules/")).length
}

/**
 * Compare an installed copy against the repository it came from.
 *
 * Drift is three named lists: shipped files the copy is missing, files whose bytes differ,
 * and files the copy has that the repository does not ship. This is the diagnostic a link
 * could never give: a junction pointed at the live tree and so always agreed with itself.
 */
export function driftReport(path: string, root: string): Drift {
  const shipped = shippableFiles(root)
  const missing: string[] = []
  const changed: string[] = []
  const compareEntry = (relative: string): void => {
    const from = join(root, relative)
    const to = join(path, relative)
    if (!existsSync(to)) {
      missing.push(relative)
      return
    }
    if (statSync(from).isDirectory()) {
      for (const leaf of fileTree(from)) compareEntry(relative + "/" + leaf)
      return
    }
    if (hashFile(from) !== hashFile(to)) changed.push(relative)
  }
  for (const entry of shipped) compareEntry(entry)
  const extra = fileTree(path).filter(
    (relative) =>
      !shipped.some((entry) => relative === entry || relative.startsWith(entry + "/")) &&
      !relative.startsWith("node_modules/"),
  )
  return { missing, changed, extra }
}

/** Copy the shippable set into a directory, and report how many files that was. */
function copyManifest(path: string, root: string): number {
  mkdirSync(path, { recursive: true })
  for (const entry of shippableFiles(root)) {
    const from = join(root, entry)
    const to = join(path, entry)
    if (statSync(from).isDirectory()) mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
  }
  return countFiles(path)
}

/**
 * Remove a link.
 *
 * `rmSync` with `recursive` would follow the link and delete the *target's* contents, so a
 * plain `rmSync` is issued without the flag. This path exists only for the junctions the
 * installer used to create: the first install after the switch to copies clears them this
 * way, and an uninstall of a legacy install does the same for anything still linked.
 */
function removeLink(path: string): void {
  if (isLink(path)) {
    rmSync(path)
    return
  }
  rmSync(path, { recursive: true, force: true })
}

/**
 * Copy the package into a discovery directory.
 *
 * Idempotent, on bytes: a copy that matches the shipped set exactly is left alone and
 * reported as `current` — nothing is written. Anything else is replaced with a fresh copy
 * of exactly the shipped set, because a reinstall is an upgrade. A directory that is really
 * a link (a legacy junction) is removed without recursion first.
 */
export function installInto(dir: string, root: string, scope: "user" | "project"): InstallResult {
  const name = packageName(root)
  const path = join(dir, name)

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  let action: "installed" | "updated" | "replaced" = "installed"
  if (isLink(path)) {
    // A junction from before the copy switch. It is removed without recursion, which
    // deletes the link and leaves the repository it pointed at intact.
    removeLink(path)
    action = "replaced"
  } else if (existsSync(path)) {
    const drift = driftReport(path, root)
    if (drift.missing.length === 0 && drift.changed.length === 0 && drift.extra.length === 0) {
      return { scope, path, target: root, action: "current", changed: 0 }
    }
    // A real directory is the plugin's own space; nothing the user owns lives in it, so a
    // plain recursive delete is both safe and the only way the copy ends up exact.
    rmSync(path, { recursive: true, force: true })
    action = "updated"
  }

  if (!existsSync(join(root, ENTRY))) {
    throw new Error(`${root} has no ${ENTRY}; run from the package root`)
  }

  const changed = copyManifest(path, root)
  return { scope, path, target: root, action, changed }
}

/** Remove the plugin from a discovery directory, when it is there. */
export function uninstallFrom(dir: string, root: string, scope: "user" | "project"): InstallResult {
  const path = join(dir, packageName(root))
  if (!existsSync(path) && !isLink(path)) {
    return { scope, path, target: "", action: "missing", changed: 0 }
  }
  // removeLink is the cautious form for the one case that can destroy work if mishandled:
  // a link. A real directory is just deleted.
  removeLink(path)
  return { scope, path, target: "", action: "removed", changed: 0 }
}

/** One human-readable line describing what a discovery path holds. */
function describeInstall(path: string, root: string): string {
  if (isLink(path)) {
    let target = ""
    try {
      target = readlinkSync(path)
    } catch {
      target = "(unreadable)"
    }
    return `a junction to ${target} — from before the copy switch; install replaces it`
  }
  if (!existsSync(path)) return "(not installed)"
  if (!statSync(path).isDirectory()) return "not a directory — install replaces it"
  const drift = driftReport(path, root)
  if (drift.missing.length === 0 && drift.changed.length === 0 && drift.extra.length === 0) {
    return `a copy of the shipped set, ${countFiles(path)} file(s), in sync with the repository`
  }
  const parts = [`${drift.missing.length} missing`, `${drift.changed.length} changed`, `${drift.extra.length} extra`]
  return `a copy that has drifted from the repository (${parts.join(", ")}) — run install to sync`
}

/** Run the modes and report what happened, as the one exit code the host cares about. */
export function run(argv: readonly string[], root: string): number {
  const { project, remove, status } = parseArgs(argv)
  const scope = project ? "project" : "user"
  const dir = scope === "project" ? projectPluginDir(root) : userPluginDir()
  const label = scope === "project" ? "project scope" : "user scope"

  try {
    if (status) {
      const rows: string[] = []
      for (const candidate of discoveryDirs(root)) {
        const path = join(candidate.dir, packageName(root))
        const here = existsSync(path) || isLink(path)
        const pad = candidate.scope === "project" ? "project" : "user   "
        rows.push(`  ${pad} ${candidate.dir}` + (here ? "\n    " + describeInstall(path, root) : "\n    (not installed)"))
      }
      process.stdout.write(`${packageName(root)} discoverable from:\n` + rows.join("\n") + "\n")
      return 0
    }

    const result = remove ? uninstallFrom(dir, root, scope) : installInto(dir, root, scope)
    const verb =
      result.action === "installed"
        ? `installed into ${label} (${result.changed} file(s))`
        : result.action === "updated"
          ? `updated the copy in ${label} (${result.changed} file(s) synced)`
          : result.action === "replaced"
            ? `replaced a legacy junction in ${label} with a copy (${result.changed} file(s))`
            : result.action === "removed"
              ? `removed from ${label}`
              : result.action === "current"
                ? `already installed in ${label}, in sync — nothing written`
                : `nothing to remove from ${label}`
    process.stdout.write(`${verb}\n  ${result.path}\n`)
    if (result.action === "installed" || result.action === "updated" || result.action === "replaced") {
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
    const path = join(entry.dir, packageName(root))
    return existsSync(path) || isLink(path) ? entry.scope + ": installed" : entry.scope + ": absent"
  })
}
