import { fail } from "./errors.ts"

/**
 * Reads answers from stdin. On a terminal, `secret` turns echo off; from a pipe, `secret`
 * takes the rest of stdin, so `printf %s "$value" | sops-secret add ...` works too.
 */
export class Prompter {
  private buffer = ""
  private ended = false
  private waiting: (() => void) | undefined
  private started = false
  private readonly input: NodeJS.ReadStream
  private readonly output: NodeJS.WriteStream

  constructor(input: NodeJS.ReadStream = process.stdin, output = process.stderr) {
    this.input = input
    this.output = output
  }

  get interactive(): boolean {
    return Boolean(this.input.isTTY)
  }

  async line(question: string): Promise<string> {
    this.output.write(question)
    this.start()
    for (;;) {
      const newline = this.buffer.indexOf("\n")
      if (newline !== -1) {
        const answer = this.buffer.slice(0, newline).replace(/\r$/, "")
        this.buffer = this.buffer.slice(newline + 1)
        return answer
      }
      if (this.ended) {
        const answer = this.buffer
        this.buffer = ""
        return answer
      }
      await this.more()
    }
  }

  async confirm(question: string): Promise<boolean> {
    return /^y(es)?$/i.test((await this.line(`${question} [y/N] `)).trim())
  }

  /** A value typed with echo off. Never written anywhere by this class. */
  async secret(question: string): Promise<string> {
    this.output.write(question)
    if (!this.interactive) {
      this.start()
      while (!this.ended) await this.more()
      const value = this.buffer.replace(/\r?\n$/, "")
      this.buffer = ""
      return value
    }
    this.input.setRawMode(true)
    this.start()
    try {
      let value = ""
      for (;;) {
        while (this.buffer.length === 0 && !this.ended) await this.more()
        if (this.buffer.length === 0) return value
        const char = this.buffer[0] as string
        this.buffer = this.buffer.slice(1)
        if (char === "\r" || char === "\n" || char === "\x04") return value
        if (char === "\x03") fail("cancelled", 130)
        if (char === "\x7f" || char === "\b") value = [...value].slice(0, -1).join("")
        else if (char === "\x15") value = ""
        else value += char
      }
    } finally {
      this.input.setRawMode(false)
      this.output.write("\n")
    }
  }

  close(): void {
    this.input.pause()
  }

  private start(): void {
    if (this.started) {
      this.input.resume()
      return
    }
    this.started = true
    this.input.setEncoding("utf8")
    this.input.on("data", (chunk: string) => {
      this.buffer += chunk
      this.wake()
    })
    this.input.on("end", () => {
      this.ended = true
      this.wake()
    })
  }

  private wake(): void {
    const waiting = this.waiting
    this.waiting = undefined
    waiting?.()
  }

  private more(): Promise<void> {
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }
}
