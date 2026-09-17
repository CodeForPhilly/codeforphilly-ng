import type { NavigateFunction } from 'react-router';

/**
 * Where to land after sign-in / account claim. Mirrors the API's
 * `safeReturnPath`: site-relative only (one leading slash), so a crafted
 * `?return=` can't bounce the browser off-site. Anything else → `/`.
 */
export function safeReturn(input: string | null): string {
  if (!input) return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

/**
 * `/api/**` is served by Fastify, not the SPA — the SAML resume endpoint hands
 * the browser on to Slack from there. Client-side routing to one of those
 * paths never reaches the server and renders the SPA's `*` NotFound instead,
 * so they need a real navigation. Everything else stays in-app.
 */
export function goToReturn(navigate: NavigateFunction, path: string): void {
  if (path.startsWith('/api/')) {
    window.location.assign(path);
    return;
  }
  void navigate(path, { replace: true });
}
