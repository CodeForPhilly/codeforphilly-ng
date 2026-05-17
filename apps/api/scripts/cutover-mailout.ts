/**
 * cutover-mailout.ts — T+90 reminder mailout to unclaimed Persons
 *
 * Pulls every public Person whose GitHub identity is still null and who has
 * a matching PrivateProfile.email, and sends each a one-shot reminder asking
 * them to sign in and claim their account. Run manually at T+90 per
 * specs/behaviors/account-migration.md#cutover-window-policy.
 *
 * --dry-run prints the would-be send list and exits — no Resend calls, no
 * disk writes. The CI test exercises only --dry-run.
 *
 * Usage:
 *   npm run -w apps/api script:cutover-mailout -- --dry-run
 *   npm run -w apps/api script:cutover-mailout -- --send --from=hello@codeforphilly.org
 *
 * Env:
 *   RESEND_API_KEY    — required for actual sends (otherwise --send refuses)
 *   CFP_PUBLIC_URL    — base URL used in the email body (defaults to
 *                       https://codeforphilly.org)
 *   CFP_DATA_REPO_PATH + STORAGE_BACKEND + bucket envs — same shape as the API
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { openPublicStore } from '../src/store/public.js';
import {
  FilesystemPrivateStore,
  S3PrivateStore,
  type PrivateStore,
} from '../src/store/private/index.js';

// ---------------------------------------------------------------------------
// Exported types (tests rely on these)
// ---------------------------------------------------------------------------

export interface MailoutRecipient {
  readonly personId: string;
  readonly slug: string;
  readonly email: string;
  readonly fullName: string | null;
}

export interface MailoutReport {
  readonly runAt: string;
  readonly mode: 'dry-run' | 'send';
  readonly recipients: ReadonlyArray<MailoutRecipient>;
  readonly skipped: ReadonlyArray<{ personId: string; reason: string }>;
  readonly sent: number;
  readonly failed: ReadonlyArray<{ personId: string; error: string }>;
}

export interface MailoutOptions {
  readonly publicStore: Awaited<ReturnType<typeof openPublicStore>>;
  readonly privateStore: PrivateStore;
  readonly mode: 'dry-run' | 'send';
  readonly from?: string;
  readonly publicUrl?: string;
  readonly send?: (input: { to: string; from: string; subject: string; html: string; text: string }) => Promise<void>;
  readonly now?: string;
}

// ---------------------------------------------------------------------------
// Recipient selection
// ---------------------------------------------------------------------------

export async function collectRecipients(
  publicStore: Awaited<ReturnType<typeof openPublicStore>>,
  privateStore: PrivateStore,
): Promise<{ recipients: MailoutRecipient[]; skipped: Array<{ personId: string; reason: string }> }> {
  const people = await publicStore.people.queryAll();
  const recipients: MailoutRecipient[] = [];
  const skipped: Array<{ personId: string; reason: string }> = [];

  for (const person of people) {
    if (person.deletedAt) {
      skipped.push({ personId: person.id, reason: 'deleted' });
      continue;
    }
    if (person.githubUserId) {
      skipped.push({ personId: person.id, reason: 'github-linked' });
      continue;
    }
    const profile = await privateStore.getProfile(person.id);
    if (!profile) {
      skipped.push({ personId: person.id, reason: 'no-private-profile' });
      continue;
    }
    if (profile.email.endsWith('@example.invalid') || profile.email.endsWith('.invalid')) {
      skipped.push({ personId: person.id, reason: 'invalid-email' });
      continue;
    }
    recipients.push({
      personId: person.id,
      slug: person.slug,
      email: profile.email,
      fullName: person.fullName ?? null,
    });
  }
  return { recipients, skipped };
}

// ---------------------------------------------------------------------------
// Email body
// ---------------------------------------------------------------------------

export function buildEmailBody(
  recipient: MailoutRecipient,
  publicUrl: string,
): { subject: string; html: string; text: string } {
  const claimUrl = `${publicUrl.replace(/\/$/, '')}/account/sign-in`;
  const name = recipient.fullName ?? recipient.slug;
  const subject = 'Action needed: claim your Code for Philly account';
  const text = [
    `Hi ${name},`,
    '',
    `We migrated codeforphilly.org to a new platform a few months ago. ` +
      `Your account at @${recipient.slug} is still waiting to be claimed.`,
    '',
    `Sign in with GitHub to claim it — your profile, projects, and Slack ` +
      `identity all carry over: ${claimUrl}`,
    '',
    `If you don't recognize this account, you can ignore the email. ` +
      `Accounts unclaimed for one year may be retired.`,
    '',
    '— Code for Philly',
  ].join('\n');
  const html =
    `<p>Hi ${escapeHtml(name)},</p>` +
    `<p>We migrated codeforphilly.org to a new platform a few months ago. ` +
    `Your account at <code>@${escapeHtml(recipient.slug)}</code> is still ` +
    `waiting to be claimed.</p>` +
    `<p><a href="${claimUrl}">Sign in with GitHub</a> to claim it — your ` +
    `profile, projects, and Slack identity all carry over.</p>` +
    `<p>If you don't recognize this account, you can ignore the email. ` +
    `Accounts unclaimed for one year may be retired.</p>` +
    `<p>— Code for Philly</p>`;
  return { subject, html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

export async function runMailout(opts: MailoutOptions): Promise<MailoutReport> {
  const runAt = opts.now ?? new Date().toISOString();
  const publicUrl = opts.publicUrl ?? 'https://codeforphilly.org';
  const from = opts.from ?? 'hello@codeforphilly.org';

  const { recipients, skipped } = await collectRecipients(opts.publicStore, opts.privateStore);

  let sent = 0;
  const failed: Array<{ personId: string; error: string }> = [];

  if (opts.mode === 'send') {
    if (!opts.send) {
      throw new Error('send mode requires a send() implementation');
    }
    for (const recipient of recipients) {
      const body = buildEmailBody(recipient, publicUrl);
      try {
        await opts.send({
          to: recipient.email,
          from,
          subject: body.subject,
          html: body.html,
          text: body.text,
        });
        sent++;
      } catch (err) {
        failed.push({
          personId: recipient.personId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    runAt,
    mode: opts.mode,
    recipients,
    skipped,
    sent,
    failed,
  };
}

// ---------------------------------------------------------------------------
// Env wiring + Resend send
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function buildPrivateStore(): PrivateStore {
  const backend = requireEnv('STORAGE_BACKEND');
  if (backend === 's3') {
    return new S3PrivateStore({
      S3_ENDPOINT: requireEnv('S3_ENDPOINT'),
      S3_BUCKET: requireEnv('S3_BUCKET'),
      S3_ACCESS_KEY_ID: requireEnv('S3_ACCESS_KEY_ID'),
      S3_SECRET_ACCESS_KEY: requireEnv('S3_SECRET_ACCESS_KEY'),
      S3_REGION: requireEnv('S3_REGION'),
    });
  }
  return new FilesystemPrivateStore({
    CFP_PRIVATE_STORAGE_PATH: requireEnv('CFP_PRIVATE_STORAGE_PATH'),
  });
}

/** Resend HTTP send. Fetch-based to avoid adding a new dep at this stage. */
async function resendSend(input: {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const apiKey = requireEnv('RESEND_API_KEY');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly dryRun: boolean;
  readonly send: boolean;
  readonly from: string | undefined;
  readonly publicUrl: string | undefined;
  readonly jsonPath: string | undefined;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const opts: Record<string, string | true> = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) opts[a.slice(2)] = true;
    else opts[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return {
    dryRun: opts['dry-run'] === true,
    send: opts['send'] === true,
    from: typeof opts['from'] === 'string' ? opts['from'] : undefined,
    publicUrl: typeof opts['public-url'] === 'string' ? opts['public-url'] : undefined,
    jsonPath: typeof opts['json'] === 'string' ? opts['json'] : undefined,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dryRun && !args.send) {
    process.stderr.write('refusing to run without --dry-run or --send\n');
    process.exit(2);
  }
  if (args.dryRun && args.send) {
    process.stderr.write('--dry-run and --send are mutually exclusive\n');
    process.exit(2);
  }

  const publicStore = await openPublicStore(requireEnv('CFP_DATA_REPO_PATH'));
  const privateStore = buildPrivateStore();
  await privateStore.load();

  const report = await runMailout({
    publicStore,
    privateStore,
    mode: args.dryRun ? 'dry-run' : 'send',
    from: args.from,
    publicUrl: args.publicUrl ?? process.env['CFP_PUBLIC_URL'],
    send: args.send ? resendSend : undefined,
  });

  process.stderr.write(
    `[cutover-mailout] mode=${report.mode} recipients=${report.recipients.length} ` +
      `skipped=${report.skipped.length} sent=${report.sent} failed=${report.failed.length}\n`,
  );

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.jsonPath) {
    await writeFile(resolve(args.jsonPath), json, 'utf8');
  } else {
    process.stdout.write(json);
  }

  process.exitCode = report.failed.length === 0 ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`[cutover-mailout] failed: ${String(err)}\n`);
    process.exit(2);
  });
}
