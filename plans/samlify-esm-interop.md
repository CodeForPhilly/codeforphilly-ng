---
status: done
depends: [saml-login-return-path]
specs:
  - specs/api/saml.md
issues: []
pr: null
---

# Plan: samlify ESM/CJS interop in the production build

## Scope

The first signed-in Slack SSO attempt against the live site 500'd:
`Cannot read properties of undefined (reading 'replaceTagsByValue')` in
`dist/saml/config.js`. samlify is CommonJS; under Node's ESM loader,
cjs-module-lexer does not detect `SamlLib` (re-exported through a getter),
so `import * as samlify` leaves it undefined and only `default`
(module.exports) carries it. vitest's interop exposes it as a named export,
which is why all 19 SAML tests passed while production failed.

In: resolve the module from whichever view carries `SamlLib`; verify the
compiled output under plain Node. Out: replacing samlify.

## Implements

- [api/saml.md](../specs/api/saml.md) — no behaviour change; the assertion
  pipeline works as specified once the library resolves.

## Approach

`apps/api/src/saml/config.ts`: pick `samlifyNs.default` when it carries
`SamlLib`, else the namespace. Verified with
`node -e "import('./dist/saml/config.js')"` after `npm run build`.

## Validation

- `npm run type-check && npm run lint`; SAML suite 19/19.
- Post-deploy: Slack "Test configuration" completes for a signed-in user.

## Follow-ups

- Tracked as: a build-output smoke test (import the compiled API under plain
  Node in CI) would have caught this before release — worth adding to
  `ci.yml` after `npm run build`.
