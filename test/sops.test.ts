import assert from "node:assert/strict"
import { test } from "node:test"
import { editorCommand, isSupported, parseSopsVersion, sopsEnv } from "../src/sops.ts"

test("parseSopsVersion reads the version line", () => {
  assert.deepEqual(parseSopsVersion("sops 3.9.0\n"), [3, 9, 0])
  assert.deepEqual(parseSopsVersion("sops 3.13.3 (latest)\n"), [3, 13, 3])
  assert.equal(parseSopsVersion("command not found"), undefined)
})

test("isSupported requires 3.11 or newer", () => {
  assert.equal(isSupported([3, 9, 0]), false)
  assert.equal(isSupported([3, 10, 2]), false)
  assert.equal(isSupported([3, 11, 0]), true)
  assert.equal(isSupported([3, 13, 3]), true)
  assert.equal(isSupported([4, 0, 0]), true)
})

test("sopsEnv drops every SOPS_ variable and sets only the key it is given", () => {
  const saved = { ...process.env }
  process.env.SOPS_AGE_RECIPIENTS = "age1other"
  process.env.SOPS_AGE_KEY_FILE = "/home/me/keys.txt"
  try {
    const env = sopsEnv("/tmp/empty", "AGE-SECRET-KEY-1X")
    assert.equal(env.SOPS_AGE_RECIPIENTS, undefined)
    assert.equal(env.SOPS_AGE_KEY_FILE, undefined)
    assert.equal(env.SOPS_AGE_KEY, "AGE-SECRET-KEY-1X")
    assert.equal(env.XDG_CONFIG_HOME, "/tmp/empty")
    assert.equal(sopsEnv("/tmp/empty").SOPS_AGE_KEY, undefined)
  } finally {
    process.env = saved
  }
})

test("editorCommand runs the editor without SOPS_AGE_KEY", () => {
  const saved = { ...process.env }
  process.env.EDITOR = "code --wait"
  delete process.env.SOPS_EDITOR
  process.env.XDG_CONFIG_HOME = "/home/o'brien/.config"
  try {
    assert.equal(
      editorCommand(),
      `env -u SOPS_AGE_KEY 'XDG_CONFIG_HOME=/home/o'"'"'brien/.config' code --wait`,
    )
  } finally {
    process.env = saved
  }
})
