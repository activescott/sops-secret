# sops-secret

Zero runtime dependencies: `src/` imports only `node:` builtins. TypeScript is compiled to
`dist/` for npm; tests run the `.ts` sources directly and the integration test runs
`dist/cli.js`.

sops 3.11 is the floor because `sops set --value-stdin` first shipped there; 3.9 and 3.10
take the value only as an argument. Before raising or lowering it, check the flag with the
sops release in question rather than its changelog.

The integration test needs `sops` and `age-keygen` on PATH. It skips without them locally
and fails without them in CI. CI runs it against the floor and the newest tested sops.
