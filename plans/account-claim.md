---
status: planned
depends: [github-oauth]
specs:
  - specs/api/account-claim.md
  - specs/screens/account-claim.md
  - specs/behaviors/account-migration.md
issues: []
---

# Plan: Account claim

## Scope

The legacy-account-claim flow: API endpoints, UI screens, staff queue. Replaces the `/account-claim` placeholder from [`github-oauth`](github-oauth.md). After this plan, a user landing with candidates can confirm (email match), decline (start fresh), verify with old password (legacy-credential path), or request staff review (dead-email fallback).

Also covers the **post-onboarding** claim flow at `/account/claim-legacy` — for users who didn't see their legacy account in the OAuth-callback candidates but realize later they had one.

Out of scope: SAML IdP ([`saml-idp`](saml-idp.md) is the parallel plan that depends on `github-oauth` not this).

## Implements

- [api/account-claim.md](../specs/api/account-claim.md) — all endpoints:
  - `GET /api/account-claim/candidates`
  - `POST /api/account-claim/confirm`
  - `POST /api/account-claim/decline`
  - `POST /api/account-claim/by-password`
  - `POST /api/account-claim/request-staff-review`
  - `GET /api/account-claim/legacy` (post-onboarding search)
  - `POST /api/account-claim/legacy/request`
  - `GET /api/staff/account-claim/queue`
  - `POST /api/staff/account-claim/:requestId/approve`
  - `POST /api/staff/account-claim/:requestId/deny`
- [screens/account-claim.md](../specs/screens/account-claim.md) — single-candidate, multi-candidate, by-password sub-screen, request-staff-review sub-screen; success confirmation
- [behaviors/account-migration.md](../specs/behaviors/account-migration.md) — three identity proofs (A: email, B: password, C: staff), merge semantics, anti-enumeration, edge cases

## Approach

### `AccountClaimRequest` records

A third entity type in the private store, alongside `PrivateProfile` and `LegacyPasswordCredential`:

```
private/
├── profiles.jsonl
├── legacy-passwords.jsonl
└── account-claim-requests.jsonl
```

`PrivateStore` interface grows methods:

```typescript
getClaimRequest(requestId): Promise<AccountClaimRequest | null>
putClaimRequest(req): Promise<void>
listOpenClaimRequests(): Promise<AccountClaimRequest[]>
markClaimRequestApproved(requestId, by, at): Promise<void>
markClaimRequestDenied(requestId, by, at, reason): Promise<void>
```

Schema:

```typescript
const AccountClaimRequestSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['pre-onboarding', 'post-onboarding-merge']),
  claimedPersonId: z.string().uuid().nullable(),
  claimedSlug: z.string(),
  requesterGithubLogin: z.string(),
  requesterGithubId: z.number().int(),
  requesterPersonId: z.string().uuid().nullable(),  // populated for post-onboarding-merge
  evidence: z.string().max(5000),
  status: z.enum(['open', 'approved', 'denied']),
  submittedAt: z.string(),  // ISO 8601
  reviewedAt: z.string().nullable(),
  reviewedBy: z.string().uuid().nullable(),
  reviewedReason: z.string().nullable(),
});
```

### Claim service (`apps/api/src/services/account-claim.ts`)

Mirrors the four pre-onboarding endpoints plus the merge logic:

- `confirm(personId, ghIdentity)` — verify email-match, link GitHub to Person, refresh email, delete LegacyPasswordCredential, mint session
- `decline(ghIdentity)` — create fresh Person + PrivateProfile, mint session
- `byPassword(slug, password, ghIdentity)` — verify legacy hash, then same as confirm
- `requestStaffReview(claimedSlug, evidence, ghIdentity)` — create AccountClaimRequest

All inside `store.transact` so the public-side mutation (linking the Person OR creating a new one) and the private-side mutation (deleting LegacyPasswordCredential, updating PrivateProfile.email) happen together.

### Legacy password verification

The laddr migration imports password hashes in their *original* algorithm — probably bcrypt or sha512crypt. Implementation:

```typescript
import bcrypt from 'bcrypt';
import { verifyLaddrPassword } from './legacy-password';

async function verifyByPassword(slug, password): Promise<boolean> {
  const person = store.public.bySlug.person.get(slug);
  if (!person || person.githubUserId) return false;  // already-claimed or unknown
  const cred = await store.private.getLegacyPassword(person.id);
  if (!cred) return false;
  return verifyLaddrPassword(password, cred.passwordHash);
}
```

`verifyLaddrPassword` is a small dispatcher that picks the verifier based on the hash format prefix (`$2a$` for bcrypt, `$6$` for sha512crypt, etc.). The exact set of algorithms is confirmed during the laddr import dry-run; document during implementation.

### Anti-enumeration

Per [behaviors/account-migration.md](../specs/behaviors/account-migration.md):

- `byPassword`: uniform 401 `claim_credentials_invalid` for not-found-slug / already-claimed / wrong-password
- `requestStaffReview`: always 202 regardless of whether the claimed slug exists

### Merge semantics

`POST /api/staff/account-claim/:requestId/approve` for a `post-onboarding-merge` request:

1. `store.transact` with both `tx.public` and `tx.private`
2. For every record authored by `requesterPersonId` (ProjectMembership, ProjectUpdate, ProjectBuzz, HelpWantedRole authored/filled, HelpWantedInterestExpression):
   - Re-point `*.personId` / `*.authorId` / `*.postedById` / `*.filledById` → `claimedPersonId`
3. Set the claimed Person's `githubUserId/Login/LinkedAt` from the requester's GH identity (the requester's fresh Person was holding these; the claimed Person needs to take them)
4. Hard-delete the requester Person (their `id` is gone from `people` sheet)
5. Refresh PrivateProfile email for the claimed Person; delete the requester's PrivateProfile
6. Write `slug-history` entry for the requester's old slug → claimed slug (90-day redirect)
7. Mark the AccountClaimRequest approved

Audit-logged via commit trailers (`Action: account-claim.approve`, etc.).

### Screens (`apps/web/src/pages/AccountClaim*.tsx`)

- `/account-claim` — main entry, fetches candidates, routes by N=0/1/N. **Replaces the placeholder shipped by [`github-oauth`](github-oauth.md)** at `apps/web/src/pages/AccountClaimPlaceholder.tsx`; the existing route in `apps/web/src/App.tsx` should be repointed to the new screen and the placeholder file deleted as part of this plan.
- `/account-claim/by-password` — username + password form
- `/account-claim/request-staff-review` — evidence textarea, submit
- `/account/claim-legacy` — post-onboarding search box → either auto-resolve (email match found, similar confirmation) or "submit for staff review" with the merge framing

### Staff queue screen (`apps/web/src/pages/StaffAccountClaimQueue.tsx`)

A staff-only screen at `/staff/account-claim` listing open requests with approve/deny buttons. Defer to [`deploy`](deploy.md) if we're tight on time — staff can use direct API calls in the interim — but I'd implement it here for completeness.

## Validation

- [ ] OAuth callback with candidates → claim screen renders the candidate(s) with the right info
- [ ] Single email-match candidate → "Yes, this is me" → API confirm → Person linked, LegacyPasswordCredential deleted, session issued, redirected
- [ ] Multi-candidate picker works; selecting one claims it; others remain unclaimed
- [ ] "No, this isn't me" → fresh Person + PrivateProfile created, session issued
- [ ] By-password verify: correct credentials → claim succeeds; wrong → uniform 401
- [ ] By-password attempts against an already-linked person → uniform 401 (no enumeration)
- [ ] Request-staff-review → 202 even for nonexistent slugs; creates AccountClaimRequest for real ones
- [ ] Post-onboarding /account/claim-legacy lets a signed-in user submit a merge request
- [ ] Staff queue lists open requests; approve runs the merge correctly (verified by inspecting the resulting commits); deny marks the request denied
- [ ] Merge correctness: every record authored by the requester Person is re-pointed; the requester Person is gone from the people sheet; PrivateProfile for the requester is deleted; slug-history entry exists
- [ ] No PII appears in any commit message body or trailer (verified by inspecting commits produced by the test)
- [ ] Anti-enumeration: error responses for unknown slugs are indistinguishable from wrong-password / not-yet-existed
- [ ] Tests cover each path with the GitHub mocks + the test-harness stores
- [ ] `AccountClaimPlaceholder` from [`github-oauth`](github-oauth.md) is removed and its `/account-claim` route now points at the real screen

## Risks / unknowns

- **Legacy password algorithm.** Need to confirm exactly which hash algorithm laddr was using before the importer runs. If bcrypt: easy. If sha512crypt: install the right verifier. If something custom: document the porting.
- **Merge edge cases.** A requester who happens to be a member of the same project the claimed Person is a member of → the post-merge state should have one membership, not two. Test this.
- **Staff-queue UI complexity.** The minimal viable version is "table + approve/deny." Can grow later. Don't over-design.

## Notes
