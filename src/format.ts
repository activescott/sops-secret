import { basename } from "node:path"
import { fail } from "./errors.ts"

export type Format = "dotenv" | "yaml"

/** Where a Kubernetes Secret keeps its values. `data` holds them base64-encoded. */
export type Section = "stringData" | "data"

/** The variable names in one map of the file. `section` is unset for a file's top level. */
export interface KeyGroup {
  section?: Section
  names: string[]
}

export interface Layout {
  format: Format
  /** A Kubernetes Secret manifest: values live under stringData and data. */
  kubernetesSecret: boolean
  groups: KeyGroup[]
}

/**
 * The format sops should be told, from the file name and, for an existing file, its
 * contents. sops guesses from the extension, which for `*.encrypted` means binary, so
 * every sops call passes --input-type and --output-type explicitly.
 */
export function formatOf(path: string, text?: string): Format {
  const name = basename(path).replace(/\.encrypted$/, "")
  if (/\.ya?ml$/.test(name)) return "yaml"
  if (name.startsWith(".env") || name.startsWith("env.") || name.endsWith(".env")) return "dotenv"
  if (text !== undefined) {
    if (/^sops_mac=/m.test(text)) return "dotenv"
    if (/^sops:/m.test(text)) return "yaml"
    if (text.trimStart().startsWith("{")) {
      fail(`${path} looks like JSON; sops-secret handles only dotenv and YAML files`)
    }
  }
  fail(`cannot tell the format of ${path}; name it *.yaml, *.yml, or .env*`)
}

/**
 * The variable names in a sops-encrypted file, read without decrypting it. sops leaves
 * keys in plaintext and encrypts only values, so this needs no key at all.
 */
export function layoutOf(path: string, text: string): Layout {
  const format = formatOf(path, text)
  if (format === "dotenv") {
    if (!/^sops_mac=/m.test(text)) fail(`${path} is not sops-encrypted`)
    return { format, kubernetesSecret: false, groups: [{ names: dotenvKeys(text) }] }
  }
  if (!/^sops:/m.test(text)) fail(`${path} is not sops-encrypted`)
  if (/^---\s*$/m.test(text.replace(/^---\s*\n/, ""))) {
    fail(`${path} holds more than one YAML document; sops-secret handles one`)
  }
  const top = yamlChildKeys(text, undefined).filter((key) => key !== "sops")
  if (!isKubernetesSecret(text, top)) {
    return { format, kubernetesSecret: false, groups: [{ names: top }] }
  }
  const groups: KeyGroup[] = []
  for (const section of ["stringData", "data"] as const) {
    if (top.includes(section)) groups.push({ section, names: yamlChildKeys(text, section) })
  }
  return { format, kubernetesSecret: true, groups }
}

export function namesOf(layout: Layout): string[] {
  return [...new Set(layout.groups.flatMap((group) => group.names))]
}

/**
 * Where `add` puts a variable: wherever it already is, else stringData when the Secret
 * has one or has neither, else data.
 */
export function sectionForAdd(layout: Layout, name: string): Section | undefined {
  if (!layout.kubernetesSecret) return undefined
  const existing = layout.groups.find((group) => group.names.includes(name))
  if (existing) return existing.section
  if (layout.groups.some((group) => group.section === "stringData")) return "stringData"
  if (layout.groups.some((group) => group.section === "data")) return "data"
  return "stringData"
}

/** The sops index expression for a variable, e.g. `["stringData"]["PASSWORD"]`. */
export function sopsIndex(name: string, section?: Section): string {
  const parts = section ? [section, name] : [name]
  return parts.map((part) => `[${JSON.stringify(part)}]`).join("")
}

const NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/

export function checkName(name: string, layout: Pick<Layout, "format" | "kubernetesSecret">) {
  if (!NAME.test(name)) {
    fail(`"${name}" is not a valid name; use letters, digits, "_", "." and "-"`)
  }
  if (layout.format === "dotenv" && name.startsWith("sops_")) {
    fail(`"${name}" collides with sops' own metadata; names starting "sops_" are reserved`)
  }
  if (layout.format === "yaml" && !layout.kubernetesSecret && name === "sops") {
    fail(`"sops" is where sops keeps its metadata; pick another name`)
  }
}

function dotenvKeys(text: string): string[] {
  const keys: string[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq)
    if (!key.startsWith("sops_")) keys.push(key)
  }
  return keys
}

function isKubernetesSecret(text: string, top: string[]): boolean {
  if (/^kind:\s*["']?Secret["']?\s*$/m.test(text)) return true
  // With no encrypted_regex in .sops.yaml, sops encrypts `kind` too, so the shape is
  // all there is to go on.
  return (
    /^kind:\s*ENC\[/m.test(text) &&
    top.includes("apiVersion") &&
    (top.includes("stringData") || top.includes("data"))
  )
}

/**
 * Keys of the top-level map, or of the map under top-level key `parent`. Line-based: it
 * reads the block-style YAML sops writes, where each encrypted value sits on its key's line.
 */
function yamlChildKeys(text: string, parent: string | undefined): string[] {
  const lines = text.split("\n")
  let start = 0
  let end = lines.length
  if (parent !== undefined) {
    start = lines.findIndex((line) => !/^\s/.test(line) && yamlKey(line) === parent) + 1
    if (start === 0) return []
    end = lines.findIndex((line, i) => i >= start && isContent(line) && !/^\s/.test(line))
    if (end === -1) end = lines.length
  }
  let indent: number | undefined
  const keys: string[] = []
  for (const line of lines.slice(start, end)) {
    if (!isContent(line)) continue
    const lineIndent = line.length - line.trimStart().length
    indent ??= parent === undefined ? 0 : lineIndent
    if (lineIndent !== indent) continue
    const key = yamlKey(line.trimStart())
    if (key !== undefined) keys.push(key)
  }
  return keys
}

function isContent(line: string): boolean {
  const trimmed = line.trim()
  return trimmed !== "" && !trimmed.startsWith("#") && trimmed !== "---" && trimmed !== "..."
}

function yamlKey(line: string): string | undefined {
  if (line.startsWith("- ") || line === "-") return undefined
  if (line.startsWith('"')) {
    const match = line.match(/^("(?:[^"\\]|\\.)*")\s*:(\s|$)/)
    if (!match?.[1]) return undefined
    try {
      return JSON.parse(match[1]) as string
    } catch {
      return match[1].slice(1, -1)
    }
  }
  if (line.startsWith("'")) {
    const match = line.match(/^'((?:[^']|'')*)'\s*:(\s|$)/)
    return match?.[1]?.replace(/''/g, "'")
  }
  return line.match(/^(.+?)\s*:(\s|$)/)?.[1]
}
