import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { configPath, normalizeRef, readConfig, writeConfig } from "../src/config.ts"
import { redact } from "../src/errors.ts"

const root = mkdtempSync(join(tmpdir(), "sops-secret-config-test-"))
after(() => rmSync(root, { recursive: true, force: true }))

test("normalizeRef accepts vault/item/field and op:// forms", () => {
  assert.equal(normalizeRef("Private/sops age/private key"), "op://Private/sops age/private key")
  assert.equal(normalizeRef(" op://v/i/f \n"), "op://v/i/f")
  assert.equal(normalizeRef("op://v/i/section/f"), "op://v/i/section/f")
  assert.throws(() => normalizeRef("v/i"), /not a 1Password reference/)
  assert.throws(() => normalizeRef("op://v//f"), /not a 1Password reference/)
})

test("normalizeRef never echoes a pasted private key", () => {
  const key = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"
  assert.throws(
    () => normalizeRef(key),
    (error: Error) => !error.message.includes(key) && /private key/.test(error.message),
  )
})

test("configPath prefers an existing config, then the git root, then .sops.yaml", () => {
  const repo = join(root, "repo")
  const deep = join(repo, "apps", "x")
  mkdirSync(deep, { recursive: true })
  writeFileSync(join(repo, "apps", ".sops.yaml"), "creation_rules: []\n")
  assert.equal(configPath(deep), join(repo, "apps", ".sops-secret.json"))
  mkdirSync(join(repo, ".git"))
  assert.equal(configPath(deep), join(repo, ".sops-secret.json"))
  writeFileSync(join(deep, ".sops-secret.json"), "{}")
  assert.equal(configPath(deep), join(deep, ".sops-secret.json"))
})

test("readConfig round-trips what writeConfig saves", () => {
  const path = join(root, "rt.json")
  assert.equal(readConfig(path), undefined)
  writeConfig(path, { ageKeyRef: "op://v/i/f" })
  assert.deepEqual(readConfig(path), { ageKeyRef: "op://v/i/f" })
  writeFileSync(path, '{"other": 1}')
  assert.throws(() => readConfig(path), /ageKeyRef/)
})

test("redact removes every occurrence of each secret", () => {
  assert.equal(redact("a hunter2 b hunter2", ["hunter2", ""]), "a [redacted] b [redacted]")
})
