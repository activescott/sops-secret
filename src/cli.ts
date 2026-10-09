#!/usr/bin/env node
// Edit, add, remove and list values in sops+age encrypted files. The encrypted files are
// the only copy of each secret; 1Password holds one thing, the age private key.
//
// The key is read with `op read` only for commands that decrypt (edit, add to an existing
// file, rm), and reaches sops only through SOPS_AGE_KEY in the child's environment. It is
// never written to disk, never logged, and never passed as an argument.

import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { configPath, findUp, normalizeRef, readConfig, writeConfig } from "./config.ts"
import { CliError, fail } from "./errors.ts"
import {
  checkName,
  formatOf,
  layoutOf,
  namesOf,
  sectionForAdd,
  sopsIndex,
  type Layout,
} from "./format.ts"
import { readAgeKey } from "./onepassword.ts"
import { Prompter } from "./prompt.ts"
import { editorCommand, requireSops, sops, sopsEnv, typeArgs } from "./sops.ts"

const USAGE = `Usage:
  sops-secret edit <path>        decrypt into $EDITOR, re-encrypt on a clean exit
  sops-secret add <path> <name>  prompt for a value (no echo) and set it
  sops-secret rm <path> <name>   remove a variable
  sops-secret ls <path>          list variable names, never values

Recipients come from .sops.yaml. The age private key is read from 1Password with \`op\`,
using the reference saved in .sops-secret.json.`

function note(message: string): void {
  console.error(message)
}

class Session {
  readonly cwd: string
  readonly prompter: Prompter
  private tmp: string | undefined

  constructor(cwd: string, prompter: Prompter) {
    this.cwd = cwd
    this.prompter = prompter
  }

  /** An empty directory for the sops child's XDG_CONFIG_HOME. */
  emptyConfigHome(): string {
    if (!this.tmp) {
      this.tmp = mkdtempSync(join(tmpdir(), "sops-secret-"))
      mkdirSync(join(this.tmp, "config"), { mode: 0o700 })
    }
    return join(this.tmp, "config")
  }

  /**
   * The age private key. The first time in a repo this asks for its 1Password reference,
   * and saves the reference only after `op read` has returned a key from it.
   */
  async ageKey(): Promise<string> {
    const path = configPath(this.cwd)
    const config = readConfig(path)
    if (config) return readAgeKey(config.ageKeyRef)

    note(
      `No 1Password reference for the age private key yet; it will be saved in ${this.show(path)}.`,
    )
    const answer = await this.prompter.line("1Password reference (vault/item/field or op://...): ")
    const ageKeyRef = normalizeRef(answer)
    const key = readAgeKey(ageKeyRef)
    writeConfig(path, { ageKeyRef })
    note(`Saved ${this.show(path)}. Commit it; it names the key and holds no secret.`)
    return key
  }

  env(ageKey?: string): NodeJS.ProcessEnv {
    return sopsEnv(this.emptyConfigHome(), ageKey)
  }

  show(path: string): string {
    const rel = relative(this.cwd, path)
    return rel === "" || rel.startsWith("..") ? path : rel
  }

  cleanup(): void {
    if (this.tmp) rmSync(this.tmp, { recursive: true, force: true })
  }
}

function readExisting(session: Session, path: string): string {
  if (!existsSync(path)) fail(`${session.show(path)} does not exist`)
  return readFileSync(path, "utf8")
}

async function commandEdit(session: Session, path: string): Promise<void> {
  requireSops()
  if (!existsSync(path)) {
    fail(`${session.show(path)} does not exist; create it with \`sops-secret add\``)
  }
  const format = formatOf(path, readFileSync(path, "utf8"))
  const env = session.env(await session.ageKey())
  env.SOPS_EDITOR = editorCommand()

  // sops decrypts into a temp file in a 0700 directory of its own and removes it whatever
  // the editor does. It re-encrypts only when the editor exits 0 and the content changed.
  // Ctrl-C belongs to the editor; without a handler it would also kill this process and
  // hand the terminal back while the editor is still running.
  const ignore = () => {}
  process.on("SIGINT", ignore)
  try {
    const result = spawnSync("sops", ["edit", ...typeArgs(format), path], {
      env,
      stdio: "inherit",
    })
    if (result.error) fail(`sops edit failed to start: ${result.error.message}`)
    // 200 is sops' FileHasNotBeenModified.
    if (result.status === 200) return note(`${session.show(path)} unchanged`)
    if (result.status !== 0) {
      fail(
        `sops edit exited ${result.status ?? "on a signal"}; ${session.show(path)} was not changed`,
      )
    }
    note(`Saved ${session.show(path)}`)
  } finally {
    process.off("SIGINT", ignore)
  }
}

async function readValue(session: Session, name: string): Promise<string> {
  const hidden = session.prompter.interactive ? " (input hidden)" : ""
  const value = await session.prompter.secret(`Value for ${name}${hidden}: `)
  if (value === "") fail("empty value; nothing written")
  return value
}

async function commandAdd(session: Session, path: string, name: string): Promise<void> {
  requireSops()
  if (!existsSync(path)) return createWith(session, path, name)

  const layout = layoutOf(path, readFileSync(path, "utf8"))
  checkName(name, layout)
  const section = sectionForAdd(layout, name)
  const existed = namesOf(layout).includes(name)
  const env = session.env(await session.ageKey())
  const value = await readValue(session, name)
  const stored = section === "data" ? Buffer.from(value, "utf8").toString("base64") : value
  const input = JSON.stringify(stored)
  sops(["set", ...typeArgs(layout.format), "--value-stdin", path, sopsIndex(name, section)], {
    env,
    input,
    secrets: [value, stored, input],
  })
  const where = section ? ` (${section})` : ""
  note(`${existed ? "Updated" : "Added"} ${name}${where} in ${session.show(path)}`)
}

/** Encrypting needs only the recipients' public keys, so creating a file reads no key. */
async function createWith(session: Session, path: string, name: string): Promise<void> {
  const format = formatOf(path)
  checkName(name, { format, kubernetesSecret: false })
  if (!existsSync(dirname(path))) fail(`directory ${session.show(dirname(path))} does not exist`)
  if (!findUp(session.cwd, ".sops.yaml")) {
    fail(`no .sops.yaml in ${session.cwd} or above; sops-secret takes recipients only from there`)
  }
  if (!(await session.prompter.confirm(`${session.show(path)} does not exist. Create it?`))) {
    fail("nothing written")
  }
  const value = await readValue(session, name)
  const input = JSON.stringify({ [name]: value })
  const ciphertext = sops(
    ["encrypt", "--input-type", "json", "--output-type", format, "--filename-override", path],
    {
      env: session.env(),
      input,
      secrets: [value, input, JSON.stringify(value)],
    },
  )
  // Written beside the target and renamed, so a failed write leaves no partial file.
  const staging = `${path}.tmp.${process.pid}`
  try {
    writeFileSync(staging, ciphertext, { flag: "wx" })
    if (existsSync(path)) fail(`${session.show(path)} appeared while encrypting; left it alone`)
    renameSync(staging, path)
  } finally {
    rmSync(staging, { force: true })
  }
  note(`Created ${session.show(path)} with ${name}, encrypted to the recipients in .sops.yaml`)
}

async function commandRm(session: Session, path: string, name: string): Promise<void> {
  requireSops()
  const layout = layoutOf(path, readExisting(session, path))
  const groups = layout.groups.filter((group) => group.names.includes(name))
  if (groups.length === 0) fail(`no ${name} in ${session.show(path)}`)
  const env = session.env(await session.ageKey())
  for (const group of groups) {
    sops(["unset", ...typeArgs(layout.format), path, sopsIndex(name, group.section)], { env })
  }
  note(`Removed ${name} from ${session.show(path)}`)
}

function commandLs(session: Session, path: string): void {
  const layout: Layout = layoutOf(path, readExisting(session, path))
  for (const name of namesOf(layout)) console.log(name)
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  return String(pkg.version)
}

async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" }, version: { type: "boolean" } },
    })
  } catch (error) {
    console.error(`sops-secret: ${(error as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (parsed.values.version) {
    console.log(version())
    return 0
  }
  const [command, target, name, ...extra] = parsed.positionals
  if (parsed.values.help || command === undefined || command === "help") {
    console.log(USAGE)
    return parsed.values.help || command === "help" ? 0 : 2
  }
  const arity: Record<string, number> = { edit: 1, ls: 1, add: 2, rm: 2 }
  const expected = arity[command]
  const given = [target, name, ...extra].filter((arg) => arg !== undefined).length
  if (expected === undefined || given !== expected) {
    console.error(
      expected === undefined
        ? `sops-secret: unknown command "${command}"\n\n${USAGE}`
        : `sops-secret: ${command} takes ${expected} argument(s)\n\n${USAGE}`,
    )
    return 2
  }

  const prompter = new Prompter()
  const session = new Session(cwd, prompter)
  const path = resolve(cwd, target as string)
  try {
    if (command === "edit") await commandEdit(session, path)
    else if (command === "add") await commandAdd(session, path, name as string)
    else if (command === "rm") await commandRm(session, path, name as string)
    else commandLs(session, path)
    return 0
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`sops-secret: ${error.message}`)
      return error.exitCode
    }
    throw error
  } finally {
    prompter.close()
    session.cleanup()
  }
}

process.exitCode = await main(process.argv.slice(2))
