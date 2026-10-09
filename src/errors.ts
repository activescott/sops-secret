/** Thrown instead of calling process.exit so cleanup in `finally` still runs. */
export class CliError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

export function fail(message: string, exitCode = 1): never {
  throw new CliError(message, exitCode)
}

/**
 * Replaces every occurrence of each secret in `text`. Used on child stderr before it is
 * shown, in case a tool ever echoes its input back in an error.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    out = out.split(secret).join("[redacted]")
  }
  return out
}
