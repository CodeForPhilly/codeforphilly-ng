---
status: planned
depends: [write-api]
specs:
  - specs/api/auth.md
  - specs/behaviors/account-migration.md
  - specs/screens/login.md
issues: []
---

# Plan: GitHub OAuth

## Scope

Replace the `auth-jwt-substrate` issuance stub with the real GitHub OAuth flow: `GET /api/auth/github/start`, `GET /api/auth/github/callback`, PKCE, identity-resolution-to-Person via the matching algorithm. **The callback resolves to one of three outcomes — existing-linked, fresh, or claim-pending** — and either issues a session or hands off a claim-pending JWT to be consumed by the next plan.

Out of scope: the account-claim screens + endpoints ([`account-claim`](account-claim.md) follows); SAML IdP ([`saml-idp`](saml-idp.md)). After this plan, signing in via GitHub works end-to-end for "existing GitHub-linked user" and "brand-new user" cases. Legacy users without a GitHub link land on a claim screen that 501s until the next plan unstubs it.

## Implements

- [api/auth.md](../specs/api/auth.md) — the `/github/start` and `/github/callback` endpoints; PKCE; CSRF state cookie; claim-pending JWT issuance
- [behaviors/account-migration.md](../specs/behaviors/account-migration.md) — the matching algorithm (githubUserId → existing linked → email match → username weak match → outcome routing). The actual *consumption* of the claim-pending JWT is in [`account-claim`](account-claim.md).
- [screens/login.md](../specs/screens/login.md) — the "Sign in with GitHub" button now actually navigates to the live `/start` endpoint; `?error=…` query parameters render the documented messages

## Approach

### OAuth flow plumbing (`apps/api/src/auth/github.ts`)

1. **`GET /api/auth/github/start`**:
   - Generate 32-byte CSPRNG state token
   - Generate PKCE code verifier + S256 challenge
   - Sign a session cookie `cfp_oauth_session` carrying `{ state, codeVerifier, return }`
   - Redirect to `https://github.com/login/oauth/authorize` with the documented query params + `scope=read:user user:email`

2. **`GET /api/auth/github/callback`**:
   - Decode `cfp_oauth_session`; verify state matches query param
   - Exchange code at `https://github.com/login/oauth/access_token` (POST) with the code_verifier
   - Fetch `GET https://api.github.com/user` + `GET https://api.github.com/user/emails`
   - Filter `emails` to `{verified: true}` entries
   - Resolve to a Person via the matching algorithm (below)
   - One of three outcomes: existing → session, fresh → session, candidates → claim-pending JWT

### Matching algorithm (`apps/api/src/services/account-matching.ts`)

Per [behaviors/account-migration.md](../specs/behaviors/account-migration.md):

```typescript
async function resolveIdentity(gh: GhIdentity, store: Store): Promise<MatchResult> {
  // 1. Direct hit
  const linked = store.public.byGithubUserId.get(gh.id);
  if (linked) return { kind: 'existing', personId: linked.id };

  // 2. Email match against any verified GH email
  const verifiedEmails = gh.emails.filter(e => e.verified).map(e => e.email.toLowerCase());
  const emailMatches = new Set<string>();
  for (const email of verifiedEmails) {
    const pid = await store.private.findPersonIdByEmail(email);
    if (pid) {
      const person = store.public.byId.get(pid);
      if (person && !person.githubUserId) emailMatches.add(pid);  // skip already-linked
    }
  }

  // 3. Username weak match
  const usernameMatch = store.public.bySlug.person.get(gh.login.toLowerCase());
  const candidates = new Set(emailMatches);
  if (usernameMatch && !usernameMatch.githubUserId && !candidates.has(usernameMatch.id)) {
    candidates.add(usernameMatch.id);
  }

  // 4. Route
  if (candidates.size === 0) return { kind: 'create-fresh' };
  return { kind: 'candidates', candidates: [...candidates], matchedEmail: verifiedEmails[0] };
}
```

### Outcome routing

`apps/api/src/routes/auth.ts` `/github/callback` handler:

```typescript
const match = await resolveIdentity(gh, store);
switch (match.kind) {
  case 'existing':
    await refreshGitHubLogin(match.personId, gh);    // update Person.githubLogin
    await refreshEmail(match.personId, gh.primaryEmail);  // update PrivateProfile.email
    mintSessionFor(match.personId, reply);
    return reply.redirect(safeReturn(state.return));

  case 'create-fresh':
    const person = await createPersonFromGitHub(gh, store);
    await createPrivateProfile(person.id, gh.primaryEmail, store);
    mintSessionFor(person.id, reply);
    return reply.redirect(safeReturn(state.return));

  case 'candidates':
    mintClaimPendingFor(gh, match.candidates, reply);
    return reply.redirect(`/account-claim?return=${encodeURIComponent(state.return)}`);
}
```

`mintSessionFor` and `mintClaimPendingFor` from [`auth-jwt-substrate`](auth-jwt-substrate.md).

### Person + PrivateProfile creation for "fresh" path

Inside `store.transact`:

1. Generate UUIDv7 for `Person.id`
2. Derive `Person.slug` from `gh.login` (slugify, dedupe with `-2`/`-3`)
3. Populate from GitHub: `fullName`, `githubUserId`, `githubLogin`, `githubLinkedAt`, `slackSamlNameId = slug`
4. `tx.public.sheet('people').upsert(person)`
5. `tx.private.putProfile({ personId, email, emailRefreshedAt: now, updatedAt: now })`

The commit's trailers carry `Action: person.create`, `Actor-Slug: '<slug>'` (the new user themselves are the actor), etc.

### Claim flow handoff

If `candidates`: the API mints `cfp_claim` with `{ candidates, ghLogin, ghName, ghEmails, exp:+5m }` and redirects to `/account-claim`. The `/account-claim` screen (currently 501ed) is built in the next plan.

For this plan: add a temporary placeholder route in the web app at `/account-claim` that shows "Claim flow coming in the next plan" + the OAuth identity it received (so a test user can see "yeah this is the right account"). Replaced fully in [`account-claim`](account-claim.md).

### Error handling

Per [api/auth.md](../specs/api/auth.md): redirect to `/login?error=<code>` on each failure mode. The `<Login>` component (already in [`web-shell`](web-shell.md) + [`public-screens`](public-screens.md)) renders the documented messages.

### `me` shape update

`GET /api/auth/me` now returns `me.email` (from PrivateProfile) for the authenticated user. This is a small `read-api` adjustment landing in this plan since the data didn't exist before.

## Validation

- [ ] OAuth happy path: never-seen-this-user → clicks Sign in with GitHub → GitHub auth → callback → fresh Person + PrivateProfile created → session issued → redirected to `/`
- [ ] OAuth returning user: a Person with `githubUserId` set → callback → session issued → no Person/PrivateProfile mutations beyond email refresh + githubLogin refresh
- [ ] OAuth with candidates: a Person without `githubUserId` exists whose PrivateProfile.email matches a GitHub-verified email → callback → claim-pending JWT issued → redirected to `/account-claim` placeholder
- [ ] CSRF: tampering with the `state` query param → 401 `oauth_state_mismatch`
- [ ] PKCE: GitHub returns an error → handled gracefully → redirected to `/login?error=…`
- [ ] User denies on GitHub (`error=access_denied`) → redirected to `/login?error=access_denied` with the documented message
- [ ] GitHub returns no verified emails → redirected to `/login?error=email_unverified` with the documented help message
- [ ] `cfp_oauth_session` cookie expires after 10 minutes; expired sessions fail with `oauth_session_invalid`
- [ ] Tests: mock GitHub via the test-harness mocks; cover each outcome (existing / fresh / candidates) + each error mode

## Risks / unknowns

- **GitHub OAuth app setup.** Need a GitHub OAuth App registered with `https://codeforphilly.org/api/auth/github/callback` (and a `dev.codeforphilly.org`-style callback for staging). Document the setup in the plan's Notes as we go.
- **Email-visibility quirks.** Some users have all emails set to private on GitHub. We've documented `email_unverified` as the dead end; verify GitHub returns something useful in that case.
- **`gh.login` slugify collisions.** `kebab-case-this-name` might already be taken by an existing legacy slug. The dedup-with-`-2`/`-3` is a clean fallback but the resulting fresh slug could look weird (`jane-doe-3`). Acceptable for v1; staff can rename later if needed.

## Notes
