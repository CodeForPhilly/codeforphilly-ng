# Behavior: Password Hash Rotation

## Rule

`LegacyPasswordCredential.passwordHash` carries hashes in **any of three** algorithms — laddr's unsalted SHA-1, bcrypt, or argon2id. The verifier detects algorithm by format and, on every successful login, **rehashes** the supplied plaintext to argon2id and overwrites the stored hash.

The result: active users drift toward modern hashing without forcing a password reset. SHA-1 hashes only persist for accounts that haven't been used since cutover.

## Applies To

- [api/auth.md](../api/auth.md) — `POST /api/auth/login` performs the verify + rehash; `POST /api/auth/password-reset/confirm` writes only argon2id
- [behaviors/account-migration.md](account-migration.md) — the legacy sign-in path that triggers rehash on every successful login
- [data-model.md → LegacyPasswordCredential](../data-model.md) — schema carries the algorithm-agnostic `passwordHash` string
- [behaviors/private-storage.md](private-storage.md) — credential reads and writes go through the private store

## Hash formats

| Algorithm | Origin | Format prefix | Notes |
| --------- | ------ | ------------- | ----- |
| Unsalted SHA-1 | Laddr's `User.class.php` (`$passwordHasher = 'SHA1'`) | bare 40-char lowercase hex (no prefix) | Broken — rainbow-tables crack every common password. Every legacy import lands here. |
| bcrypt | Defensive fallback for any future bcrypt-imported credentials | `$2a$`, `$2b$`, `$2y$` | Acceptable. Library-native verify. Not the target. |
| argon2id | Native rewrite | `$argon2id$` | The target — every rehash and every new password lands here. |

Detection is by prefix:

```text
if passwordHash starts with "$argon2id$" → argon2id
if passwordHash starts with "$2a$" or "$2b$" or "$2y$" → bcrypt
if passwordHash matches /^[0-9a-f]{40}$/ → unsalted SHA-1
otherwise → unknown_format (verify fails, uniform 401)
```

The SHA-1 detection is permissive on input ("bare 40-char hex") and conservative on intent — any unrecognized shape is treated as `unknown_format`, never as a fallback to SHA-1.

## Verification

For each algorithm:

- **argon2id** — `argon2.verify(stored, plaintext)`. Library-native; constant-time by design.
- **bcrypt** — `bcrypt.compare(plaintext, stored)`. Library-native; constant-time by design.
- **SHA-1** — Compute `sha1(plaintext)` → 40-char hex; constant-time-compare against `stored` using `crypto.timingSafeEqual` (after equal-length check). **Never** use `===` or `==` — laddr's PHP code used loose `==` which is timing-leaky on hash compare.

If any branch throws (corrupt hash, encoding mismatch, etc.), treat as `invalid_credentials` — never let an internal error leak through as a distinct response.

## Rehash on every successful login

`POST /api/auth/login` (per [api/auth.md](../api/auth.md)) runs after a successful verify:

```text
1. verify(plaintext, stored) === true
2. newHash = argon2id(plaintext, params = current default)
3. write LegacyPasswordCredential with passwordHash = newHash, lastUsedAt = now
4. mint session, return success
```

The rehash happens **regardless of the source algorithm**. Reasoning:

- SHA-1 sources need rehashing — that's the point of the rule.
- bcrypt sources are correct *today*, but argon2id is the project's chosen algorithm. Unifying on one algorithm simplifies the verifier and removes legacy paths.
- argon2id sources may have been hashed under older parameters (memory, iterations). Rehashing with current params keeps the credential corpus at the current security floor.

The verifier returns `{ valid, needsRehash }` for clarity even though every `valid=true` case currently triggers a rehash:

```ts
{ valid: true, needsRehash: true }   // SHA-1 source
{ valid: true, needsRehash: true }   // bcrypt source
{ valid: true, needsRehash: true }   // argon2id source with old params
{ valid: true, needsRehash: false }  // argon2id source with current params — write skipped
{ valid: false, needsRehash: false } // any failure
```

`needsRehash = false` for current-params argon2id avoids a useless write on every login. The detection: argon2's encoded hash carries its parameters; compare against the current parameter set; skip if identical.

## Argon2id parameters

Implementation chooses parameters at module load from a single source of truth (`apps/api/src/auth/argon2-params.ts` or similar). Recommended starting values:

- `memoryCost`: 19456 KiB (≈ 19 MiB)
- `timeCost`: 2 iterations
- `parallelism`: 1

These produce ~50 ms hashes on the production pod's CPU profile (Linode amd64). Within budget for `POST /api/auth/login` latency.

Parameter changes are a **deliberate spec event**: bump the constants in code, deploy, and every subsequent successful login rehashes to the new floor. No retroactive backfill (the corpus drifts naturally).

## Password recovery

`POST /api/auth/password-reset/confirm` writes only argon2id — there is no path that produces a SHA-1 or bcrypt hash from rewrite code. SHA-1 hashes can only enter the system via the laddr import.

## Anti-enumeration timing

The verifier's responses across the three algorithms must be indistinguishable from a wall-clock attacker:

- **Equal-length compare floor.** Even when `passwordHash` is absent or `unknown_format`, the route runs an `argon2id` hash against a fixed dummy plaintext before returning 401. This ensures "no such user" and "wrong password" take comparable time.
- **No early bail on missing credential.** If the username resolves to a Person with no `LegacyPasswordCredential`, the dummy verify path still runs.

The constant-time SHA-1 compare uses `crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(stored, 'hex'))` after length-checking — `timingSafeEqual` throws synchronously on length mismatch, which is itself a timing oracle if the lengths differ. Length-check first, then compare.

## Sunset

When SHA-1 source records drop to zero (every legacy user has either logged in once OR been deactivated), the SHA-1 detection path can be removed. Not a v1 concern; tracked as a follow-up signal in [account-migration.md](account-migration.md#sunset-deferred).

## Operational metrics (for future sunset planning)

`LegacyPasswordCredential` carries `lastUsedAt: iso8601 nullable` to support coverage reporting:

- "How many active password users in the last 30/90/365 days?"
- "What % of those active users have linked GitHub?"
- "How many SHA-1 records remain (lastUsedAt is null OR pre-cutover)?"

These feed the future sunset decision in [account-migration.md](account-migration.md#sunset-deferred).

## Coordinates with

- [api/auth.md](../api/auth.md) — the verify + rehash sits inside `POST /api/auth/login`
- [behaviors/account-migration.md](account-migration.md) — why password sign-in exists, who's eligible
- [data-model.md → LegacyPasswordCredential](../data-model.md) — credential record shape (passwordHash, lastUsedAt)
- [behaviors/private-storage.md](private-storage.md) — credential records live in the private store
