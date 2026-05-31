---
status: done
depends: [login-migration-strategy]
specs:
  - specs/behaviors/password-hash-rotation.md
  - specs/data-model.md
issues: []
pr: 118
---

# Plan: login-migration impl — phase A (verifier + rehash infrastructure)

## Scope

First implementation chunk for [login-migration-strategy](./login-migration-strategy.md). This phase is **infrastructure only** — no new user-facing routes yet. It builds the verifier the login route will use:

1. **argon2 dependency** + parameter constants
2. **Three-algorithm verifier** — SHA-1 (with constant-time compare), bcrypt, argon2id — returning `{ valid, needsRehash }`
3. **Rehash helper** — produces argon2id encoded hash with current params
4. **`LegacyPasswordCredential.lastUsedAt` field** — supports the coverage metric
5. **Existing `account-claim` service** updated to use the new verifier (preserves behavior — same successful auth, same uniform-fail; gains the SHA-1 path so the `wrong_password` outcome for SHA-1 hashes becomes valid)

After this lands, the login route in phase B can call `verifyAndDecideRehash` and rehash via the helper — both pure functions, easy to test.

## Implements

- [behaviors/password-hash-rotation.md](../specs/behaviors/password-hash-rotation.md) — verifier algorithm dispatch, constant-time compare, rehash semantics.
- [data-model.md → LegacyPasswordCredential](../specs/data-model.md) — `lastUsedAt` field.

## Approach

### 1. Dependency: argon2

```bash
npm install --workspace apps/api argon2
```

`argon2` (the native bindings, not `argon2-browser`) — well-maintained, fast, the project's chosen target algorithm. Doesn't need a build step in the Docker image (prebuilt binaries for `linux/amd64`).

### 2. Parameter constants

`apps/api/src/auth/argon2-params.ts` — single source of truth:

```ts
export const ARGON2_PARAMS = {
  type: argon2.argon2id,
  memoryCost: 19456,  // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;
```

Documented per the password-hash-rotation spec. Bumping these is a deliberate spec event.

### 3. Refactor `apps/api/src/auth/legacy-password.ts`

Replace `verifyLaddrPassword(password, hash): Promise<boolean>` with:

```ts
type VerifyResult =
  | { valid: true; needsRehash: boolean }
  | { valid: false };

export async function verifyLegacyPassword(
  password: string,
  hash: string,
): Promise<VerifyResult>;

export async function rehashPassword(password: string): Promise<string>;
```

`verifyLegacyPassword` dispatches by format:

- `^\$argon2id\$` → `argon2.verify(stored, plaintext)`; `needsRehash` true if encoded params differ from `ARGON2_PARAMS`
- `^\$2[aby]\$` → `bcrypt.compare(plaintext, stored)`; `needsRehash: true` (we're unifying on argon2id)
- `^[0-9a-f]{40}$` → SHA-1 path: compute `crypto.createHash('sha1').update(plaintext).digest('hex')`, length-check, `crypto.timingSafeEqual(Buffer, Buffer)`; `needsRehash: true`
- Anything else → `{ valid: false }` (no throw, no leak)

On any thrown error inside any branch → `{ valid: false }`. Never let internal errors surface as distinct outcomes.

`UnknownHashFormatError` is removed — callers no longer need to distinguish "wrong password" from "unknown format"; both yield `{ valid: false }`.

### 4. Anti-enumeration timing floor

Export a `dummyArgon2Verify()` that runs `argon2.verify` against a fixed argon2id-hashed plaintext. Callers (the future login route, password-reset, etc.) invoke it when the user/credential lookup fails, so wall-clock times across `no user`, `no credential`, `wrong password`, and `valid` paths are comparable.

The dummy hash is computed once at module load (no live secret).

### 5. `LegacyPasswordCredential` schema

`packages/shared/src/schemas/legacy-password-credential.ts`:

```ts
export const LegacyPasswordCredentialSchema = z.object({
  personId: z.string().uuid(),
  passwordHash: z.string().min(1),
  importedAt: z.string().datetime({ offset: true }),
  lastUsedAt: z.string().datetime({ offset: true }).nullable().optional(),
});
```

Existing records without `lastUsedAt` parse cleanly (optional). New records (rehashed on login) carry `lastUsedAt`.

Update `specs/data-model.md` LegacyPasswordCredential section to list the new field.

### 6. Existing `account-claim` service uses the new verifier

`apps/api/src/services/account-claim.ts:byPassword`:

- Replace `verifyLaddrPassword` import with `verifyLegacyPassword` + `rehashPassword`
- On `{ valid: true, needsRehash }`: same as today (claim succeeds) — but ALSO rehash + update credential record in the same private-store mutation. The existing `byPassword` path deletes the credential anyway after a successful claim (the user's now GitHub-linked); rehash is a no-op there.

Actually — looking at the current flow, `byPassword` deletes the credential on success, so rehash is moot inside `byPassword`. The new login route (phase B) will be the first caller that *keeps* the credential after success + rehashes. For phase A, the account-claim path stays semantically identical; it just gains the SHA-1 verify path.

### 7. Tests

`apps/api/tests/legacy-password.test.ts` (new):

- Verify argon2id hash with current params → `{ valid: true, needsRehash: false }`
- Verify argon2id hash with stale params → `{ valid: true, needsRehash: true }`
- Verify bcrypt hash → `{ valid: true, needsRehash: true }`
- Verify SHA-1 hash → `{ valid: true, needsRehash: true }`
- Wrong password against each algorithm → `{ valid: false }`
- Length-mismatched SHA-1 input doesn't throw, returns `{ valid: false }`
- Unknown format → `{ valid: false }`, no throw
- `rehashPassword` produces a parseable argon2id hash
- `dummyArgon2Verify` returns false but takes comparable time to a real verify (timing approximation — within 2x of a normal argon2 verify)

`apps/api/tests/account-claim.test.ts`:

- Add a SHA-1 hash case that succeeds (proves the new path is wired)
- Existing bcrypt cases still pass

## Validation

- [x] `npm install --workspace apps/api argon2` lands as its own commit
- [x] `verifyLegacyPassword` covers SHA-1 / bcrypt / argon2id paths with the right `needsRehash` flag — 14 tests
- [x] SHA-1 compare uses `crypto.timingSafeEqual` after length check
- [x] `LegacyPasswordCredential.lastUsedAt` is optional + nullable; existing records parse
- [x] `data-model.md` LegacyPasswordCredential section lists `lastUsedAt` (also updated the surrounding prose to reflect the keep-and-rotate-on-login posture rather than the previous delete-on-claim posture)
- [x] account-claim `byPassword` still works against bcrypt; gains a SHA-1 case — 17/17 account-claim tests pass
- [x] `npm run type-check && npm run lint` clean. Full `npm test` sweep validated separately.

## Risks / unknowns

- **`argon2` native build on Apple Silicon dev machines.** The native module needs to compile if no prebuilt is available; should work since the dev `Dockerfile` is x86_64 anyway. If install hangs locally, fall back to `argon2-browser` (pure JS) — slower but no native dep.
- **`bcrypt.compare` vs `bcryptjs.compare`.** Existing dep is `bcryptjs`. Keep using it — drops the native compile concern.
- **Length-mismatched SHA-1.** `timingSafeEqual` throws on length mismatch, which is itself a timing oracle. Code must length-check first. Covered by the test.
- **The rehash-on-bcrypt case is debatable.** Some shops keep bcrypt because changing algorithms is risk. The spec says we unify on argon2id, so this PR rehashes bcrypt → argon2id on successful verify. If usage telemetry later shows bcrypt-source records are zero (they should be — laddr is SHA-1), we can drop the bcrypt branch entirely.

## Notes

Three commits: plan-open, `npm install argon2`, verifier + tests.

Surprises:

- **`UnknownHashFormatError` had a real caller that needed dropping.**
  `apps/api/src/routes/account-claim.ts:269` distinguished
  `unknown_format` only for an internal log warning — the user-facing
  response was uniform either way. With the new verifier collapsing
  the cases, the internal log branch goes away too. The
  password-hash-rotation spec's "no algorithm leak even in internal
  logs" stance is now strict.
- **`crypto.timingSafeEqual` synchronous throw on length mismatch.**
  The spec called this out as a timing-oracle if the throw path
  differs from the compare path. Implementation length-checks the
  computed-vs-stored hex strings *before* the timing-safe compare —
  guaranteed identical lengths by the SHA-1 regex + sha1's
  fixed-40-char output, but defense-in-depth.
- **`argon2.needsRehash` exists.** Didn't have to roll my own
  encoded-hash param-comparison. Library does it correctly.
- **`bcryptjs` already a dep.** Stuck with it (pure JS, no native
  compile concern) instead of switching to the native `bcrypt`
  package. The verifier doesn't care which.
- **Dummy-verify lazy init.** The fixed sentinel hash is computed
  lazily on first `dummyVerify` call. Avoids blocking module load
  for ~50ms on every boot. The first request that hits a missing-user
  path pays the precomputation cost; subsequent requests reuse the
  cached promise.

## Follow-ups

- **Phase B — `POST /api/auth/login` route.** Wires this verifier
  into a real login endpoint, with the keep-and-rotate flow that
  account-claim doesn't trigger (claim deletes the credential on
  success; login keeps it). *Deferred to plan* —
  `plans/login-migration-impl-phase-b.md`.
- **Phase C — password reset.** `POST /api/auth/password-reset/{request,confirm}` + `PasswordToken` private record + email notifier integration. *Deferred to plan* — `plans/login-migration-impl-phase-c.md`.
- **Phase D — link-github.** `POST /api/auth/link-github` + link-mode OAuth callback variant + account banner + SPA flow. *Deferred to plan* — `plans/login-migration-impl-phase-d.md`.
- **Param-tuning calibration.** The argon2 params (19 MiB / 2 iter)
  are starting values per the spec. Once running on the production
  pod, measure actual per-login latency and adjust. *None* for v1 —
  not a blocker.
