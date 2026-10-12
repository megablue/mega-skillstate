/**
 * The host entry point.
 *
 * The OpenCode loader resolves `<plugin-root>/server` before `<plugin-root>/index`,
 * probing `.ts` ahead of `.js`, so this file is all a directory install needs.
 *
 * @module server
 */

export { default } from "./src/adapters/opencode/index.ts"
