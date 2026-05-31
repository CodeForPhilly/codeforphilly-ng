---
status: done
depends: [login-migration-impl-phase-c]
specs:
  - specs/api/auth.md
  - specs/behaviors/account-migration.md
  - specs/screens/account.md
issues: []
pr: 121
---

# Plan: login-migration impl — phase D (link-github)

## Scope

Final phase of the [login-migration-strategy](./login-migration-strategy.md) implementation track. Implements `POST /api/auth/link-github` + the link-mode GitHub OAuth callback variant + the `/account` banner that nags legacy-password users to bind a GitHub identity.

What ships:

- **`POST /api/auth/link-github`** — auth-required; sets a link-mode `cfp_oauth_session` cookie and redirects to GitHub OAuth.
- **GitHub callback branches on mode.** Existing `mode = 'login'` path unchanged. New `mode = 'link'` path looks up the GitHub identity, rejects 409 `github_already_linked` / 409 `github_id_in_use_elsewhere`, mutates the Person, redirects to `/account?linked=github` (or 302-error to `/account?error=<code>`).
- **`/account` banner.** Persistent, dismissible-per-session banner above the cards when `hasGitHubLink === false` and `lastLoginMethod` is `'legacy_password'` or `'password_reset'`. CTA: "Connect GitHub" → POST link-github.
- **Identity card update.** Replaces the hardcoded "GitHub — Connected" with conditional rendering: connected when `hasGitHubLink`, otherwise a "Connect GitHub" button + a short explainer.

## Implements

- [api/auth.md](../specs/api/auth.md) — `POST /api/auth/link-github` endpoint + callback's link-mode error codes.
- [behaviors/account-migration.md](../specs/behaviors/account-migration.md) — the nag-toward-linking story now has a UI surface.
- [screens/account.md](../specs/screens/account.md) — banner + identity-card linking flow.

## Approach

### 1. Extend `OAuthSessionClaims` with mode + linkPersonId

`apps/api/src/auth/oauth-session-cookie.ts` — add two optional fields:

```ts
export interface OAuthSessionClaims {
  state: string;
  codeVerifier: string;
  return: string;
  mode?: 'login' | 'link';            // default 'login' for back-compat
  linkPersonId?: string;              // present iff mode === 'link'
}
```

`signOAuthSession` writes them when set; `verifyOAuthSession` parses them back, defaulting `mode` to `'login'` when absent. Existing tests + cookies issued by `/api/auth/github/start` keep working unchanged.

### 2. `POST /api/auth/link-github` route

In `apps/api/src/routes/auth.ts`. Auth-required (uses `requireAuth`). Pipeline:

1. Validate session → personId.
2. Fast-fail if the Person already has a GitHub link (409 `github_already_linked`).
3. Generate state + PKCE; sign an oauth-session cookie with `mode: 'link'` + `linkPersonId: personId`.
4. Set state + session cookies; redirect to `buildAuthorizeUrl(...)`.

Body is empty. The route returns 302. Rate-limit covered by the global `/api/auth/*` 10/min/IP cap.

### 3. GitHub callback link-mode branch

The route handler at `/api/auth/github/callback` already verifies the state + oauth-session cookie. New code: if `sessionClaims.mode === 'link'`, the entire `completeCallback(...)` path is skipped (no session minting / no Person matching). Instead, a new `completeLinkCallback(...)` helper:

1. Exchange code → token (same `exchangeCodeForToken`).
2. Fetch identity (same `fetchGitHubUser` + `fetchGitHubEmails` + `resolveIdentitySnapshot`).
3. Look up the linking Person. If already linked → `github_already_linked`.
4. Search `inMemoryState.personIdByGithubUserId` for `String(identity.id)`. If found on a *different* person → `github_id_in_use_elsewhere`.
5. Transact a Person mutation: `githubUserId`, `githubLogin`, `githubLinkedAt = now`. Optionally refresh `PrivateProfile.email` if the GitHub primary email differs and the user hasn't customized — for v1, **do not** refresh the email automatically; the spec says "only if the user consents at the link-confirmation screen" and we don't have that screen yet. Future ticket.
6. Apply stateApply; redirect to `/account?linked=github` (success) or `/account?error=<code>`.

The error redirect target differs from the login path (`/login?error=...` for login, `/account?error=...` for link) because the user is signed-in throughout.

### 4. SPA — `api.auth.linkGitHub()` helper

A thin wrapper that POSTs to `/api/auth/link-github` and *follows the redirect* in the browser. Since `POST` → 302 doesn't follow naturally in fetch, the cleanest UX is to render this as a form submission (or simply `window.location.assign('/api/auth/link-github')` + accept the implied "this requires a POST" → use a small hidden form). Actually simpler: the spec says the route is `POST /api/auth/link-github`; we render an HTML `<form method="POST" action="/api/auth/link-github">` and submit it on button click. That hits the route as a real form post, the route 302s, the browser follows → GitHub. Round-trip without JS-fetch ceremony.

### 5. `/account` banner

In `apps/web/src/screens/Account.tsx`. New component `<ConnectGitHubBanner />` rendered above the cards when:

- `person !== null` and `auth.hasGitHubLink === false` and `auth.lastLoginMethod !== 'github'`.

Contents:

- One-sentence pitch: "Connect your GitHub account for faster sign-in next time — and so we can sunset password sign-in eventually."
- Primary CTA: "Connect GitHub" (a `<form>` POST to `/api/auth/link-github`).
- Dismissable for the session via `useState`; persistence across reloads is not v1 (the spec says persistent, not dismissable-forever).

Also surface success via `?linked=github` toast.

Identity card update: render "GitHub: not connected" + a small "Connect GitHub" button as the secondary entry-point when `hasGitHubLink` is false.

### 6. Extend `AuthState`

`useAuth()` currently exposes `person`, `loading`, `reload`, `signOut`. Add `hasGitHubLink: boolean` and `lastLoginMethod: 'github' | 'legacy_password' | 'password_reset' | null` so the banner + identity card can branch without an extra fetch. Wire from `/api/auth/me` response (already returned by the API since phase B).

### 7. Tests

- **`apps/api/tests/auth-link-github.test.ts` (new)** — 5 cases:
  - 401 for unauthenticated POST.
  - 409 `github_already_linked` when the calling person already has a GitHub link.
  - Happy path: sets oauth-session cookie with `mode = 'link'` + `linkPersonId`, sets state cookie, redirects to GitHub authorize URL.
  - Callback link-mode: rejects 409 `github_id_in_use_elsewhere` when GitHub identity matches a different Person.
  - Callback link-mode happy path: mutates Person.githubUserId etc., redirects to `/account?linked=github`.
- **`apps/web/tests/Account.test.tsx` (new — first Account screen test file)** — 3 cases:
  - Banner renders for legacy-password user with `hasGitHubLink: false`.
  - Banner does NOT render for github-signed-in user.
  - Banner dismiss button hides it for the session.

## Validation

- [x] `POST /api/auth/link-github` route requires auth, sets link-mode cookie, redirects to GitHub.
- [x] Callback recognizes `mode = 'link'`, branches into link path, mutates Person on success, redirects to `/account?linked=github`.
- [x] Conflict cases (`github_already_linked`, `github_id_in_use_elsewhere`) return 302 to `/account?error=<code>`.
- [x] `/account` banner renders only when `hasGitHubLink === false` AND `lastLoginMethod` ∈ `{'legacy_password', 'password_reset'}`.
- [x] Identity card on `/account` shows "Connect GitHub" CTA when `hasGitHubLink` is false.
- [x] `useAuth()` exposes `hasGitHubLink` + `lastLoginMethod`.
- [x] `npm run type-check && npm run lint` clean.
- [x] 5 new API tests pass; 5 new web tests pass; full sweep (api 387 + web 68 + shared 75) clean.

## Risks / unknowns

- **PrivateProfile email refresh on link is skipped in v1.** The spec calls for a consent toggle at the link confirmation screen ("keep current email" vs "use GitHub email"). v1 ships without the toggle and without the auto-refresh — the link only updates the Person's GitHub fields. The email-refresh path is deferred to a future ticket; legacy-imported emails stay until the user edits them on profile-edit.
- **Conflict on `github_id_in_use_elsewhere` is staff-mediated.** The spec doesn't define a self-service merge flow; the user just sees the error code and has to email staff. v1 surfaces the error; staff merge tooling is out of scope.
- **Older sessions without `loginMethod` claim.** Pre-phase-B sessions report `lastLoginMethod: null`. For the banner predicate, `null` is treated as "don't show" — these are GitHub-linked anyway (the only kind issued before phase B), so the identity card already says "connected." Benign.
- **Banner dismissal is session-only.** No localStorage / cookie persistence. Acceptable v1 — the banner exists to nag, and a per-tab dismiss is enough relief; rendering it again next session is a feature, not a bug.

## Notes

Shipped clean — all 5 API tests + 5 web tests pass on first full sweep. Type-check + lint green.

Surprises:

- **The route is a POST with no body**, which is a slightly awkward affordance from the SPA: we render it as an HTML `<form method="POST" action="/api/auth/link-github">` and let the browser submit + follow the 302. The alternative (fetch with `redirect: 'manual'` + JS-side `window.location.assign(...)`) was strictly worse — same number of round-trips, more code, and no CSRF win since the cookie does the gating already. Form post matches the spec semantics directly.
- **`hasGitHubLink` derivation lives in two places.** The API computes it from `Person.githubUserId !== null` in `/api/auth/me`. The SPA passes it through `useAuth()` from the `me` response. Resist the urge to also derive it client-side from `person.githubUserId` — that field isn't in the SPA's `AuthPerson` shape, and pulling it through would widen the auth surface for no benefit.
- **OAuth-session cookie schema is forward-extensible.** Existing pre-link-flow cookies don't carry `mode` or `linkPersonId`; the verifier defaults `mode` to `'login'`. Worth noting because it sets a precedent: future flow modes (e.g., admin-impersonate, OAuth scope-upgrade) can ride the same cookie with no compatibility shim. The 10-minute TTL bounds the back-compat window anyway.
- **No CardTitle role=heading in shadcn.** First test pass used `getByRole('heading', { name: /identity/i })` — shadcn's CardTitle renders as a div by default. Switched the wait-for selector to text-based. Worth remembering for future Account tests: shadcn Cards aren't semantic headings unless you wrap them.
- **`completeLinkCallback` is intentionally separate from `completeCallback`.** Sharing code would mean threading a `mode` discriminator through identity-resolution, session-mint, and notifier logic that aren't relevant to linking. The two pipelines share only the prefix (token exchange + identity fetch); after that they diverge entirely. Easier to keep them parallel.

## Follow-ups

- **Email-refresh consent toggle on link.** Spec calls for a confirmation screen that lets the user opt to swap their on-file email to GitHub's primary. v1 skips both the screen and the auto-swap. *Tracked as* — a follow-up issue file when the SPA gets the screen design.
- **Self-service GitHub unlink.** Not in v1 per spec. *None* — staff-mediated only.
- **Sunset commitment for password sign-in.** The strategy plan deferred this; once the coverage metric (legacy-password users with linked GitHub) crosses some threshold, we should publish a sunset date. *None* — wait for the data.
- **Login-migration track complete.** Phases A-D shipped: verifier (A), legacy password login route (B), password reset (C), link-github + banner (D). The track is **closed** as a feature initiative; future work (sunset, unlink, email-consent) gets its own plans.
