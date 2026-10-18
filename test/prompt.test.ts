import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { Prompter } from "../src/prompt.ts"

class FakeTTY extends EventEmitter {
  readonly isTTY = true
  setRawMode(): boolean {
    return true
  }
  setEncoding(): this {
    return this
  }
  pause(): this {
    return this
  }
  resume(): this {
    return this
  }
}

class FakeOutput {
  readonly chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function prompter(): { prompter: Prompter; input: FakeTTY; output: FakeOutput } {
  const input = new FakeTTY()
  const output = new FakeOutput()
  return {
    prompter: new Prompter(
      input as unknown as NodeJS.ReadStream,
      output as unknown as typeof process.stderr,
    ),
    input,
    output,
  }
}

test("secret echoes one * per typed character and never the value itself", async () => {
  const { prompter: p, input, output } = prompter()
  const result = p.secret("Value: ")
  for (const char of "hi") {
    await flush()
    input.emit("data", char)
  }
  await flush()
  input.emit("data", "\r")
  assert.equal(await result, "hi")
  assert.equal(output.chunks.filter((c) => c === "*").length, 2)
  assert.ok(!output.chunks.some((c) => c.includes("h") || c.includes("i")))
})

test("secret echoes one * per character in a multi-character paste", async () => {
  const { prompter: p, input, output } = prompter()
  const result = p.secret("Value: ")
  await flush()
  input.emit("data", "pasted\r")
  assert.equal(await result, "pasted")
  assert.equal(output.chunks.filter((c) => c === "*").length, "pasted".length)
})

test("secret erases one * per backspace", async () => {
  const { prompter: p, input, output } = prompter()
  const result = p.secret("Value: ")
  await flush()
  input.emit("data", "abc")
  await flush()
  input.emit("data", "\x7f\x7f")
  await flush()
  input.emit("data", "x\r")
  assert.equal(await result, "ax")
  const stars = output.chunks.filter((c) => c === "*").length
  const erases = output.chunks.filter((c) => c === "\b \b").length
  assert.equal(stars, 4)
  assert.equal(erases, 2)
})

test("secret stays silent when stdin is piped", async () => {
  class FakePipe extends EventEmitter {
    readonly isTTY = false
    setEncoding(): this {
      return this
    }
  }
  const input = new FakePipe() as unknown as NodeJS.ReadStream
  const output = new FakeOutput()
  const p = new Prompter(input, output as unknown as typeof process.stderr)
  const result = p.secret("Value: ")
  input.emit("data", "piped-value\n")
  input.emit("end")
  assert.equal(await result, "piped-value")
  assert.ok(!output.chunks.some((c) => c === "*"))
})
