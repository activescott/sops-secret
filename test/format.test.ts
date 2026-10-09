import assert from "node:assert/strict"
import { test } from "node:test"
import { CliError } from "../src/errors.ts"
import { checkName, formatOf, layoutOf, namesOf, sectionForAdd, sopsIndex } from "../src/format.ts"

const ENC = "ENC[AES256_GCM,data:aGk=,iv:aXY=,tag:dGFn,type:str]"

const SOPS_YAML_FOOTER = `sops:
    age:
        - recipient: age1qqq
          enc: |
            -----BEGIN AGE ENCRYPTED FILE-----
            YWdl
            -----END AGE ENCRYPTED FILE-----
    mac: ${ENC}
    version: 3.9.0
`

test("formatOf picks dotenv from .env names and yaml from the extension", () => {
  assert.equal(formatOf("a/.env.secret.app.encrypted"), "dotenv")
  assert.equal(formatOf("env.prod"), "dotenv")
  assert.equal(formatOf("prod.env"), "dotenv")
  assert.equal(formatOf("secret.yaml"), "yaml")
  assert.equal(formatOf("secret.sops.yml"), "yaml")
  assert.equal(formatOf("secret.yaml.encrypted"), "yaml")
})

test("formatOf sniffs the contents when the name says nothing", () => {
  assert.equal(formatOf("creds.encrypted", `A=${ENC}\nsops_mac=${ENC}\n`), "dotenv")
  assert.equal(formatOf("creds.encrypted", `a: ${ENC}\n${SOPS_YAML_FOOTER}`), "yaml")
  assert.throws(() => formatOf("ghcr.dockerconfigjson.encrypted", '{\n"a": 1}'), /JSON/)
  assert.throws(() => formatOf("zot-htpasswd.encrypted"), CliError)
})

test("layoutOf lists dotenv names and skips sops metadata and comments", () => {
  const text = [
    "# a comment",
    `DATABASE_URL=${ENC}`,
    "",
    `JWT_SECRET=${ENC}`,
    "sops_age__list_0__map_recipient=age1qqq",
    `sops_mac=${ENC}`,
    "sops_version=3.9.0",
  ].join("\n")
  const layout = layoutOf(".env.secret.app.encrypted", text)
  assert.deepEqual(namesOf(layout), ["DATABASE_URL", "JWT_SECRET"])
  assert.equal(layout.kubernetesSecret, false)
})

test("layoutOf lists top-level YAML keys only", () => {
  const text = `a: ${ENC}
list:
    - ${ENC}
nested:
    inner: ${ENC}
"quoted: key": ${ENC}
'single''s': ${ENC}
block_unencrypted: |
    not: a key
${SOPS_YAML_FOOTER}`
  assert.deepEqual(namesOf(layoutOf("x.yaml", text)), [
    "a",
    "list",
    "nested",
    "quoted: key",
    "single's",
    "block_unencrypted",
  ])
})

test("layoutOf reads stringData and data of a Secret with plaintext kind", () => {
  const text = `apiVersion: v1
kind: Secret
metadata:
    name: app
type: Opaque
stringData:
    PASSWORD: ${ENC}
    tls.crt: ${ENC}
data:
    blob: ${ENC}
${SOPS_YAML_FOOTER}`
  const layout = layoutOf("secret.yaml", text)
  assert.equal(layout.kubernetesSecret, true)
  assert.deepEqual(layout.groups, [
    { section: "stringData", names: ["PASSWORD", "tls.crt"] },
    { section: "data", names: ["blob"] },
  ])
  assert.equal(sectionForAdd(layout, "NEW"), "stringData")
  assert.equal(sectionForAdd(layout, "blob"), "data")
})

test("layoutOf recognizes a Secret whose kind sops encrypted", () => {
  const text = `apiVersion: ${ENC}
kind: ${ENC}
metadata:
    name: ${ENC}
data:
    blob: ${ENC}
${SOPS_YAML_FOOTER}`
  const layout = layoutOf("secret.yaml", text)
  assert.equal(layout.kubernetesSecret, true)
  assert.deepEqual(namesOf(layout), ["blob"])
  assert.equal(sectionForAdd(layout, "NEW"), "data")
})

test("layoutOf refuses files sops did not encrypt", () => {
  assert.throws(() => layoutOf(".env", "A=1\n"), /not sops-encrypted/)
  assert.throws(() => layoutOf("x.yaml", "a: 1\n"), /not sops-encrypted/)
})

test("sopsIndex quotes each part as JSON", () => {
  assert.equal(sopsIndex("A"), '["A"]')
  assert.equal(sopsIndex("tls.crt", "stringData"), '["stringData"]["tls.crt"]')
})

test("checkName rejects names that are not plain keys", () => {
  const dotenv = { format: "dotenv", kubernetesSecret: false } as const
  checkName("DATABASE_URL", dotenv)
  checkName(".dockerconfigjson", { format: "yaml", kubernetesSecret: true })
  assert.throws(() => checkName("-rf", dotenv), CliError)
  assert.throws(() => checkName('A"]["B', dotenv), CliError)
  assert.throws(() => checkName("sops_mac", dotenv), /reserved/)
  assert.throws(() => checkName("sops", { format: "yaml", kubernetesSecret: false }), CliError)
})
