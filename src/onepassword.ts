import { fail, redact } from "./errors.ts"
import { run } from "./sops.ts"

const SIGNIN_HELP = [
  "Is the 1Password CLI signed in? Either:",
  "  - turn on 1Password > Settings > Developer > 'Integrate with 1Password CLI', or",
  "  - export OP_SERVICE_ACCOUNT_TOKEN=<service account token>",
].join("\n")

/**
 * Reads the age private key with `op read`. The key is returned to be passed to sops in
 * SOPS_AGE_KEY and nowhere else: never written to disk, never logged, never an argument.
 */
export function readAgeKey(ref: string): string {
  const result = run("op", ["read", "--no-newline", ref])
  if (result.status !== 0) {
    const key = result.stdout.toString("utf8")
    fail(`op read ${ref} failed:\n${redact(result.stderr.trim(), [key])}\n\n${SIGNIN_HELP}`)
  }
  const key = result.stdout.toString("utf8").trim()
  if (!key.includes("AGE-SECRET-KEY-")) fail(`${ref} does not hold an age private key`)
  return key
}
