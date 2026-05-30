/**
 * Email templates for help-wanted notifications.
 *
 * Plain-text + HTML versions of each message. Bodies are interpolated
 * inline; they're short enough that a template engine would be more
 * overhead than the strings themselves. URLs are absolute (resolved
 * against the configured siteHost) so links work from email clients.
 */
import type { HelpWantedFillNotification, HelpWantedInterestNotification } from './index.js';

/** Strip an absolute URL down to scheme + host + path. Useful for log lines. */
export function buildRoleUrl(siteHost: string, projectSlug: string, roleId: string): string {
  // Anchor the role on the project detail page; the front-end opens the
  // help-wanted section by the role's id.
  return `https://${siteHost}/projects/${projectSlug}#help-wanted-${roleId}`;
}

/** Escape characters that have HTML meaning. Minimal but correct for our payloads. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface InterestTemplate {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function renderInterestEmail(
  n: HelpWantedInterestNotification,
  siteHost: string,
): InterestTemplate {
  const url = buildRoleUrl(siteHost, n.projectSlug, n.roleId);
  const subject = `Someone's interested in your help-wanted role: ${n.roleTitle}`;
  const text = [
    `${n.interestedPersonFullName} (@${n.interestedPersonSlug}) just expressed interest`,
    `in your "${n.roleTitle}" role on ${n.projectTitle}.`,
    '',
    n.message ? `Their message:\n${n.message}\n` : '',
    `View the role and reply:`,
    `  ${url}`,
    '',
    `— Code for Philly`,
  ]
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 0 auto; padding: 1rem; color: #111;">
  <p>
    <strong>${escapeHtml(n.interestedPersonFullName)}</strong>
    (<a href="https://${siteHost}/members/${encodeURIComponent(n.interestedPersonSlug)}">@${escapeHtml(n.interestedPersonSlug)}</a>)
    just expressed interest in your
    <a href="${url}">${escapeHtml(n.roleTitle)}</a> role on
    <a href="https://${siteHost}/projects/${encodeURIComponent(n.projectSlug)}">${escapeHtml(n.projectTitle)}</a>.
  </p>
${
  n.message
    ? `  <blockquote style="border-left: 3px solid #ccc; padding: 0.25rem 1rem; margin: 1rem 0; color: #333; white-space: pre-wrap;">${escapeHtml(n.message)}</blockquote>`
    : ''
}
  <p>
    <a href="${url}" style="display: inline-block; padding: 0.5rem 1rem; background: #0366d6; color: #fff; text-decoration: none; border-radius: 4px;">View the role</a>
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 2rem 0;">
  <p style="color: #666; font-size: 0.875rem;">
    You're receiving this because you're the maintainer of
    ${escapeHtml(n.projectTitle)} on Code for Philly.
  </p>
</body>
</html>`;

  return { subject, text, html };
}

export interface FilledTemplate {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function renderFilledEmail(
  n: HelpWantedFillNotification,
  siteHost: string,
): FilledTemplate {
  const subject = `Role filled: ${n.roleTitle}`;
  const filledBy = n.filledByFullName ?? 'Someone';
  const filledLink = n.filledBySlug
    ? `https://${siteHost}/members/${encodeURIComponent(n.filledBySlug)}`
    : null;

  const text = [
    `Your "${n.roleTitle}" role on ${n.projectTitle} was just marked as filled.`,
    '',
    filledBy === 'Someone'
      ? 'No specific person was attributed; you can edit the role to record who took it on.'
      : `Filled by: ${filledBy}${n.filledBySlug ? ` (@${n.filledBySlug})` : ''}`,
    '',
    `— Code for Philly`,
  ]
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 0 auto; padding: 1rem; color: #111;">
  <p>
    Your <strong>${escapeHtml(n.roleTitle)}</strong> role on
    <strong>${escapeHtml(n.projectTitle)}</strong> was just marked as filled.
  </p>
  <p>
    ${
      filledLink && n.filledBySlug
        ? `Filled by: <a href="${filledLink}">${escapeHtml(filledBy)}</a> (@${escapeHtml(n.filledBySlug)})`
        : `No specific person was attributed; you can edit the role to record who took it on.`
    }
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 2rem 0;">
  <p style="color: #666; font-size: 0.875rem;">
    You're receiving this because you're the maintainer of
    ${escapeHtml(n.projectTitle)} on Code for Philly.
  </p>
</body>
</html>`;

  return { subject, text, html };
}
