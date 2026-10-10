import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fail } from "./errors.ts"

export const CONFIG_FILE = ".sops-secret.json"

export interface Config {
  /** op:// reference to the age private key. Not a secret: it names where the key is. */
  ageKeyRef: string
}

/** The nearest directory at or above `start` that contains `name`. */
export function findUp(start: string, name: string): string | undefined {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, name))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Where the config file lives: the repo root, else the directory holding .sops.yaml, else
 * `cwd`. An existing config file anywhere above `cwd` wins over all three.
 */
export function configPath(cwd: string): string {
  const existing = findUp(cwd, CONFIG_FILE)
  if (existing) return join(existing, CONFIG_FILE)
  const root = findUp(cwd, ".git") ?? findUp(cwd, ".sops.yaml") ?? cwd
  return join(root, CONFIG_FILE)
}

export function readConfig(path: string): Config | undefined {
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    fail(`${path} is not valid JSON: ${(error as Error).message}`)
  }
  const ref = (parsed as Partial<Config> | null)?.ageKeyRef
  if (typeof ref !== "string") fail(`${path} has no "ageKeyRef" string`)
  return { ageKeyRef: normalizeRef(ref) }
}

export function writeConfig(path: string, config: Config): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
}

/** Accepts `op://vault/item/field` or `vault/item/field` and returns the op:// form. */
export function normalizeRef(input: string): string {
  const trimmed = input.trim()
  // Not echoed in either error: someone who pastes the key itself at the prompt must not
  // see it printed back.
  if (/AGE-SECRET-KEY-/i.test(trimmed)) {
    fail("that is an age private key; give the 1Password reference to it instead")
  }
  const ref = trimmed.startsWith("op://") ? trimmed : `op://${trimmed.replace(/^\/+/, "")}`
  const parts = ref.slice("op://".length).split("/")
  if (parts.length < 3 || parts.some((part) => part.trim() === "")) {
    fail("not a 1Password reference; give vault/item/field or op://vault/item/field")
  }
  return ref
}
