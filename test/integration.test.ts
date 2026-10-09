// Drives the built CLI against real sops and age-keygen with a throwaway age key. `op` is
// a fake on PATH that serves the key, and `sops` is a shim that logs its argv before
// running the real one, so the test can show no secret ever reaches an argument list.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { after, test } from "node:test"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url))

function which(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, command))) return join(dir, command)
  }
  return undefined
}

const realSops = which("sops")
const ageKeygen = which("age-keygen")
const missing = [!realSops && "sops", !ageKeygen && "age-keygen"].filter(Boolean)
const skip = missing.length > 0 ? `${missing.join(" and ")} not on PATH` : false
// CI installs both, so a skip there would hide a broken install.
if (skip && process.env.CI) throw new Error(skip)

const root = mkdtempSync(join(tmpdir(), "sops-secret-it-"))
after(() => rmSync(root, { recursive: true, force: true }))

const bin = join(root, "bin")
const repo = join(root, "repo")
const appDir = join(repo, "apps", "x")
const scratch = join(root, "tmp")
const opLog = join(root, "op.log")
const sopsLog = join(root, "sops.log")
const editorLog = join(root, "editor.log")
const KEY_REF = "op://Private/sops-age/private key"
const VALUES = ["first-secret-value", "second secret value", "third'\"value", "k8s-pass-word"]

let privateKey = ""
let publicKey = ""
const outputs: string[] = []

function script(path: string, body: string): void {
  writeFileSync(path, `#!${process.execPath}\n${body}`)
  chmodSync(path, 0o755)
}

function setup(): void {
  for (const dir of [bin, appDir, scratch, join(repo, ".git")]) mkdirSync(dir, { recursive: true })
  const keyFile = join(root, "key.txt")
  const generated = spawnSync(ageKeygen as string, ["-o", keyFile], { encoding: "utf8" })
  assert.equal(generated.status, 0, generated.stderr)
  privateKey = readFileSync(keyFile, "utf8").match(/^AGE-SECRET-KEY-\S+$/m)?.[0] ?? ""
  publicKey = readFileSync(keyFile, "utf8").match(/age1\S+/)?.[0] ?? ""
  writeFileSync(
    join(repo, ".sops.yaml"),
    `creation_rules:\n  - path_regex: ^apps/\n    age: ${publicKey}\n`,
  )
  script(
    join(bin, "op"),
    `const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(opLog)}, JSON.stringify(process.argv.slice(2)) + "\\n")
const ref = process.argv[process.argv.length - 1]
if (process.argv[2] !== "read" || ref !== ${JSON.stringify(KEY_REF)}) {
  process.stderr.write('[ERROR] "' + ref + '" isn\\'t an item\\n')
  process.exit(1)
}
process.stdout.write(fs.readFileSync(${JSON.stringify(keyFile)}, "utf8"))
`,
  )
  script(
    join(bin, "sops"),
    `const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(sopsLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  hasKey: "SOPS_AGE_KEY" in process.env,
}) + "\\n")
const r = require("node:child_process").spawnSync(${JSON.stringify(realSops)}, process.argv.slice(2), { stdio: "inherit" })
process.exit(r.status ?? 1)
`,
  )
}

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("SOPS_") && name !== "EDITOR") env[name] = value
  }
  return { ...env, PATH: `${bin}${delimiter}${process.env.PATH}`, TMPDIR: scratch }
}

function cli(args: string[], options: { input?: string; cwd?: string; env?: object } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? appDir,
    input: options.input ?? "",
    encoding: "utf8",
    env: { ...baseEnv(), ...options.env },
  })
  outputs.push(result.stdout, result.stderr)
  return result
}

function decrypt(path: string, format: string): string {
  const result = spawnSync(
    realSops as string,
    ["decrypt", "--input-type", format, "--output-type", format, path],
    { encoding: "utf8", env: { ...baseEnv(), SOPS_AGE_KEY: privateKey } },
  )
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function encryptYaml(path: string, yaml: string): void {
  const result = spawnSync(
    realSops as string,
    [
      "encrypt",
      "--age",
      publicKey,
      "--encrypted-regex",
      "^(data|stringData)$",
      "--filename-override",
      path,
    ],
    { encoding: "utf8", input: yaml, env: baseEnv() },
  )
  assert.equal(result.status, 0, result.stderr)
  writeFileSync(path, result.stdout)
}

function opCalls(): number {
  return existsSync(opLog) ? readFileSync(opLog, "utf8").trim().split("\n").length : 0
}

test("sops-secret against real sops", { skip }, async (t) => {
  setup()
  const envFile = join(appDir, ".env.secret.app.encrypted")
  const config = join(repo, ".sops-secret.json")

  await t.test("add creates a missing file with the public key only", () => {
    const result = cli(["add", ".env.secret.app.encrypted", "FIRST"], {
      input: `y\n${VALUES[0]}\n`,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(opCalls(), 0)
    assert.equal(existsSync(config), false)
    const text = readFileSync(envFile, "utf8")
    assert.match(text, new RegExp(`^sops_age__list_0__map_recipient=${publicKey}$`, "m"))
    assert.equal(decrypt(envFile, "dotenv"), `FIRST=${VALUES[0]}\n`)
  })

  await t.test("add asks before creating and writes nothing on no", () => {
    const result = cli(["add", ".env.secret.other.encrypted", "X"], { input: "n\n" })
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(join(appDir, ".env.secret.other.encrypted")), false)
  })

  await t.test("ls lists names without any key", () => {
    const result = cli(["ls", ".env.secret.app.encrypted"])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, "FIRST\n")
    assert.equal(opCalls(), 0)
  })

  await t.test("a reference op cannot read is not saved", () => {
    const result = cli(["add", ".env.secret.app.encrypted", "SECOND"], {
      input: `Private/wrong/item\n${VALUES[1]}\n`,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /isn't an item/)
    assert.equal(existsSync(config), false)
  })

  await t.test("add to an existing file prompts once for the reference and saves it", () => {
    const result = cli(["add", ".env.secret.app.encrypted", "SECOND"], {
      input: `Private/sops-age/private key\n${VALUES[1]}\n`,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { ageKeyRef: KEY_REF })
    assert.match(decrypt(envFile, "dotenv"), new RegExp(`^SECOND=${VALUES[1]}$`, "m"))
  })

  await t.test("the saved reference is used without asking again", () => {
    const result = cli(["add", "apps/x/.env.secret.app.encrypted", "THIRD"], {
      cwd: repo,
      input: `${VALUES[2]}\n`,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /1Password reference/)
    assert.match(decrypt(envFile, "dotenv"), new RegExp(`^THIRD=${VALUES[2]}$`, "m"))
  })

  await t.test("rm removes the variable", () => {
    const result = cli(["rm", ".env.secret.app.encrypted", "SECOND"])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(cli(["ls", ".env.secret.app.encrypted"]).stdout, "FIRST\nTHIRD\n")
    assert.notEqual(cli(["rm", ".env.secret.app.encrypted", "SECOND"]).status, 0)
  })

  await t.test("edit re-encrypts after a clean editor exit", () => {
    const editor = join(bin, "editor-ok")
    script(
      editor,
      `const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(editorLog)}, JSON.stringify("SOPS_AGE_KEY" in process.env) + "\\n")
fs.appendFileSync(process.argv[2], "EDITED=yes\\n")
`,
    )
    const result = cli(["edit", ".env.secret.app.encrypted"], { env: { EDITOR: editor } })
    assert.equal(result.status, 0, result.stderr)
    assert.match(decrypt(envFile, "dotenv"), /^EDITED=yes$/m)
    assert.equal(readFileSync(editorLog, "utf8"), "false\n")
  })

  await t.test("edit leaves the file and no plaintext behind when the editor fails", () => {
    const editor = join(bin, "editor-fail")
    script(
      editor,
      `require("node:fs").appendFileSync(process.argv[2], "LOST=yes\\n")
process.exit(3)
`,
    )
    const before = readFileSync(envFile)
    const result = cli(["edit", ".env.secret.app.encrypted"], { env: { EDITOR: editor } })
    assert.notEqual(result.status, 0)
    assert.deepEqual(readFileSync(envFile), before)
    assert.deepEqual(readdirSync(scratch), [])
  })

  await t.test("a Kubernetes Secret gets values in stringData, or base64 in data", () => {
    const manifest = join(appDir, "secret.yaml")
    encryptYaml(
      manifest,
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: app\nstringData:\n  USER: admin\n",
    )
    assert.equal(cli(["add", "secret.yaml", "PASSWORD"], { input: VALUES[3] }).status, 0)
    assert.equal(cli(["ls", "secret.yaml"]).stdout, "USER\nPASSWORD\n")
    assert.match(decrypt(manifest, "yaml"), new RegExp(`^ +PASSWORD: ${VALUES[3]}$`, "m"))
    assert.equal(cli(["rm", "secret.yaml", "USER"]).status, 0)
    assert.equal(cli(["ls", "secret.yaml"]).stdout, "PASSWORD\n")

    const dataOnly = join(appDir, "data.yaml")
    encryptYaml(dataOnly, "apiVersion: v1\nkind: Secret\nmetadata:\n  name: d\ndata:\n  A: YQ==\n")
    assert.equal(cli(["add", "data.yaml", "TOKEN"], { input: VALUES[3] }).status, 0)
    const base64 = Buffer.from(VALUES[3] as string).toString("base64")
    assert.match(decrypt(dataOnly, "yaml"), new RegExp(`^ +TOKEN: ${base64}$`, "m"))
  })

  await t.test("an old sops is refused by name", () => {
    const oldBin = join(root, "old-bin")
    mkdirSync(oldBin)
    script(join(oldBin, "sops"), `console.log("sops 3.10.2")\n`)
    const result = cli(["rm", ".env.secret.app.encrypted", "FIRST"], {
      env: { PATH: `${oldBin}${delimiter}${baseEnv().PATH}` },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /found sops 3\.10\.2; sops-secret needs 3\.11 or newer/)
  })

  await t.test("no secret reached an argument list or the CLI's output", () => {
    const sopsCalls = readFileSync(sopsLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const argvText =
      JSON.stringify(sopsCalls.map((call) => call.argv)) + readFileSync(opLog, "utf8")
    const printed = outputs.join("\n")
    for (const secret of [privateKey, ...VALUES]) {
      assert.equal(argvText.includes(secret), false, "a secret appeared in argv")
      assert.equal(printed.includes(secret), false, "a secret appeared in output")
    }
    // Only commands that decrypt got the key; `--version` and the new file's encrypt did not.
    const keyed = sopsCalls.filter((call) => call.hasKey).map((call) => call.argv[0])
    assert.deepEqual([...new Set(keyed)].sort(), ["edit", "set", "unset"])
    assert.deepEqual(readdirSync(scratch), [])
  })
})
