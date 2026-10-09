import { spawnSync } from "node:child_process"
import { accessSync, constants as fsConstants } from "node:fs"
import { join } from "node:path"
import { fail, redact } from "./errors.ts"
import type { Format } from "./format.ts"

export const MIN_SOPS: readonly [number, number] = [3, 11]

export interface CommandResult {
  status: number
  stdout: Buffer
  stderr: string
}

/**
 * Runs a command capturing stdout as a Buffer. stdout may hold a secret, so callers must
 * never print it.
 */
export function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) {
    const code = "code" in result.error ? result.error.code : undefined
    if (code === "ENOENT") fail(`${command} not found on PATH`)
    fail(`${command} failed to start: ${result.error.message}`)
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: (result.stderr ?? Buffer.alloc(0)).toString(),
  }
}

export function parseSopsVersion(output: string): [number, number, number] | undefined {
  const match = output.match(/sops (\d+)\.(\d+)\.(\d+)/)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isSupported(version: readonly number[]): boolean {
  const [major = 0, minor = 0] = version
  return major > MIN_SOPS[0] || (major === MIN_SOPS[0] && minor >= MIN_SOPS[1])
}

/**
 * sops 3.11 added `set --value-stdin`. Before it, `set` took the value only as an argument,
 * where `ps` shows it.
 */
export function requireSops(): void {
  const install = "Install sops 3.11 or newer: https://github.com/getsops/sops/releases"
  const result = spawnSync("sops", ["--disable-version-check", "--version"], { encoding: "utf8" })
  if (result.error) fail(`sops not found on PATH. ${install}`)
  const version = parseSopsVersion(result.stdout ?? "")
  if (result.status !== 0 || !version) {
    fail(`could not read the sops version from \`sops --version\`. ${install}`)
  }
  if (!isSupported(version))
    fail(`found sops ${version.join(".")}; sops-secret needs 3.11 or newer`)
}

export function typeArgs(format: Format): string[] {
  return ["--input-type", format, "--output-type", format]
}

/**
 * The environment for a sops child. Every SOPS_* variable is dropped so recipients come
 * only from .sops.yaml (SOPS_AGE_RECIPIENTS and friends would add to them) and the age key
 * only from 1Password. sops also reads a default keys.txt under the user config dir, so
 * XDG_CONFIG_HOME points at an empty directory; sops honours it on macOS too.
 */
export function sopsEnv(emptyConfigHome: string, ageKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("SOPS_")) env[name] = value
  }
  env.XDG_CONFIG_HOME = emptyConfigHome
  if (ageKey !== undefined) env.SOPS_AGE_KEY = ageKey
  return env
}

/** Single-quotes a word for the shlex split sops applies to SOPS_EDITOR. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'"'"'`)}'`
}

/**
 * The SOPS_EDITOR value for `sops edit`, which starts the editor with its own environment.
 * Without the `env -u` the editor, and every shell or plugin it spawns, would hold
 * SOPS_AGE_KEY. It also gets the caller's XDG_CONFIG_HOME back so its own config loads.
 */
export function editorCommand(): string {
  // The order sops itself uses.
  const editor = process.env.SOPS_EDITOR || process.env.EDITOR || defaultEditor()
  const configHome =
    process.env.XDG_CONFIG_HOME === undefined
      ? ["-u", "XDG_CONFIG_HOME"]
      : [shellQuote(`XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}`)]
  return ["env", "-u", "SOPS_AGE_KEY", ...configHome, editor].join(" ")
}

/** The editor sops falls back to when EDITOR is unset: the first of vim, nano, vi on PATH. */
function defaultEditor(): string {
  for (const name of ["vim", "nano", "vi"]) {
    for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      try {
        accessSync(join(dir, name), fsConstants.X_OK)
        return name
      } catch {
        // not here; keep looking
      }
    }
  }
  fail("EDITOR is unset and none of vim, nano, vi is on PATH; set EDITOR")
}

/** Runs sops and fails with its stderr, minus any secret, on a non-zero exit. */
export function sops(
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: string; secrets?: string[] },
): Buffer {
  const result = run("sops", args, options)
  if (result.status !== 0) {
    const secrets = [...(options.secrets ?? []), options.env.SOPS_AGE_KEY ?? ""]
    fail(`sops ${args[0]} failed:\n${redact(result.stderr.trim(), secrets)}`)
  }
  return result.stdout
}
