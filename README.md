# sops-secret

Edit, add, remove and list values in sops-encrypted files, with the age key in 1Password.

## Install

Needs Node 20 or newer, [sops](https://github.com/getsops/sops/releases) 3.11 or newer, and
the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`) signed in.

```sh
npx sops-secret ls apps/production/app/.env.secret.app.encrypted
```

or `npm install -g sops-secret`.

## Commands

```sh
sops-secret edit <path>        # decrypt into $EDITOR, re-encrypt on a clean exit
sops-secret add <path> <name>  # prompt for a value with no echo, and set it
sops-secret rm <path> <name>   # remove a variable
sops-secret ls <path>          # list variable names, never values
```

`edit` wraps `sops edit`. If the editor exits non-zero, nothing is re-encrypted and sops
removes its plaintext temp file.

`add` reads the value from the terminal with echo off, or from stdin when it is piped, and
hands it to `sops set --value-stdin`, so it never appears in an argument list or shell
history. If the file does not exist, `add` offers to create it, encrypted to the recipients
in `.sops.yaml`; creating a file needs no private key.

`ls` reads the names straight from the encrypted file, since sops leaves keys in plaintext,
so it needs no key at all.

Files are dotenv (`.env*`, `*.env`, or contents with `sops_mac=`) or YAML (`*.yaml`, `*.yml`).
For a Kubernetes Secret manifest, `add`, `rm` and `ls` work on `stringData`, or on `data`
with the value base64-encoded when the Secret has only `data`.

## Configuration

Recipients come only from the repo's `.sops.yaml`, which sops finds by walking up from the
current directory.

`edit`, `rm`, and `add` to an existing file need the age private key. The first time, you
are asked for its 1Password reference (`vault/item/field` or `op://vault/item/field`), and
it is saved in `.sops-secret.json` at the repo root:

```json
{
  "ageKeyRef": "op://Private/sops-age-key/private key"
}
```

Commit it. It names where the key is and holds no secret, and nobody is asked again.

## Tenets

- The only secret in 1Password is the age private key. Every other secret exists only in
  the encrypted files.
- Secret values are visible only through `edit`. sops-secret never prints one, including
  in errors.
- The private key is read with `op read` only when a command needs it, and reaches sops only
  through `SOPS_AGE_KEY` in the child's environment. It is never written to disk or passed
  as an argument, and the editor runs without it. Other `SOPS_*` variables and any local
  `keys.txt` are ignored.

## Releasing

[release-please](https://github.com/googleapis/release-please) opens and updates a release
PR from conventional commits on `main`. Merging it tags a release, which
`.github/workflows/release.yml` publishes to npm with
[provenance](https://docs.npmjs.com/generating-provenance-statements) via OIDC trusted
publishing: no `NPM_TOKEN` is stored anywhere.
