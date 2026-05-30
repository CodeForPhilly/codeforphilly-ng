/**
 * Tests for the Resend-backed EmailNotifier (apps/api/src/notify/email-notifier.ts).
 *
 * Mocks the Resend SDK at the `emails.send` boundary — verifies that the
 * notifier composes the right payload + handles delivery success/failure
 * per the spec (express-interest must return 202 to the caller regardless).
 *
 * Template renderers are also exercised here with snapshot-style asserts
 * on the interpolated fields, since they're pure functions with simple
 * inputs.
 */
import { describe, expect, it, vi } from 'vitest';
import { EmailNotifier } from '../src/notify/email-notifier.js';
import { renderFilledEmail, renderInterestEmail } from '../src/notify/templates.js';
import type {
  HelpWantedFillNotification,
  HelpWantedInterestNotification,
} from '../src/notify/index.js';

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  level: 'info',
  // pino's BaseLogger has more; the notifier only touches info/warn/error so
  // the cast keeps the test surface narrow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const baseInterest: HelpWantedInterestNotification = {
  maintainerEmail: 'maintainer@example.com',
  maintainerSlackHandle: null,
  roleTitle: 'Frontend lead',
  projectTitle: 'SquadQuest',
  projectSlug: 'squadquest',
  roleId: '01951a3c-0000-7000-8000-000000000007',
  interestedPersonFullName: 'Jane Doe',
  interestedPersonSlug: 'jane-doe',
  message: 'I love React — let me help!',
};

const baseFill: HelpWantedFillNotification = {
  maintainerEmail: 'maintainer@example.com',
  roleTitle: 'Frontend lead',
  projectTitle: 'SquadQuest',
  filledByFullName: 'Jane Doe',
  filledBySlug: 'jane-doe',
};

function makeNotifier(emails: { send: ReturnType<typeof vi.fn> }): EmailNotifier {
  return new EmailNotifier({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resend: { emails } as any,
    fromAddress: 'Code for Philly <notifications@codeforphilly.org>',
    siteHost: 'codeforphilly.org',
    logger: noopLogger,
  });
}

describe('renderInterestEmail', () => {
  it('builds subject + text + html with all fields interpolated', () => {
    const tpl = renderInterestEmail(baseInterest, 'codeforphilly.org');
    expect(tpl.subject).toContain('Frontend lead');
    expect(tpl.text).toContain('Jane Doe');
    expect(tpl.text).toContain('@jane-doe');
    expect(tpl.text).toContain('SquadQuest');
    expect(tpl.text).toContain('I love React — let me help!');
    expect(tpl.text).toContain('https://codeforphilly.org/projects/squadquest');
    expect(tpl.html).toContain('<strong>Jane Doe</strong>');
    expect(tpl.html).toContain('href="https://codeforphilly.org/members/jane-doe"');
  });

  it('omits the message blockquote when no message', () => {
    const tpl = renderInterestEmail({ ...baseInterest, message: null }, 'codeforphilly.org');
    expect(tpl.html).not.toContain('blockquote');
    expect(tpl.text).not.toContain('Their message');
  });

  it('escapes HTML in user-supplied fields', () => {
    const tpl = renderInterestEmail(
      { ...baseInterest, message: '<script>alert(1)</script>' },
      'codeforphilly.org',
    );
    expect(tpl.html).not.toContain('<script>');
    expect(tpl.html).toContain('&lt;script&gt;');
  });
});

describe('renderFilledEmail', () => {
  it('names the filler when filledBy is set', () => {
    const tpl = renderFilledEmail(baseFill, 'codeforphilly.org');
    expect(tpl.subject).toContain('Role filled');
    expect(tpl.text).toContain('Jane Doe');
    expect(tpl.html).toContain('href="https://codeforphilly.org/members/jane-doe"');
  });

  it('omits the link when filledBy is null', () => {
    const tpl = renderFilledEmail(
      { ...baseFill, filledByFullName: null, filledBySlug: null },
      'codeforphilly.org',
    );
    expect(tpl.text).toContain('No specific person');
    expect(tpl.html).not.toContain('href="https://codeforphilly.org/members/');
  });
});

describe('EmailNotifier.notifyHelpWantedInterest', () => {
  it('sends via Resend and returns delivered:true', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'msg-123' }, error: null });
    const notifier = makeNotifier({ send });

    const result = await notifier.notifyHelpWantedInterest(baseInterest);
    expect(result).toEqual({ delivered: true });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0]![0]!;
    expect(arg.to).toBe('maintainer@example.com');
    expect(arg.from).toContain('Code for Philly');
    expect(arg.subject).toContain('Frontend lead');
    expect(arg.text).toContain('Jane Doe');
    expect(arg.html).toContain('<strong>Jane Doe</strong>');
  });

  it('returns delivered:false when maintainerEmail is null (no Resend call)', async () => {
    const send = vi.fn();
    const notifier = makeNotifier({ send });

    const result = await notifier.notifyHelpWantedInterest({
      ...baseInterest,
      maintainerEmail: null,
    });
    expect(result).toEqual({ delivered: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns delivered:false when Resend reports an error', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ data: null, error: { message: 'Sender domain unverified' } });
    const notifier = makeNotifier({ send });

    const result = await notifier.notifyHelpWantedInterest(baseInterest);
    expect(result).toEqual({ delivered: false });
  });

  it('returns delivered:false when the Resend SDK throws', async () => {
    const send = vi.fn().mockRejectedValue(new Error('network blip'));
    const notifier = makeNotifier({ send });

    const result = await notifier.notifyHelpWantedInterest(baseInterest);
    expect(result).toEqual({ delivered: false });
  });
});

describe('EmailNotifier.notifyHelpWantedFilled', () => {
  it('sends via Resend and returns delivered:true', async () => {
    const send = vi.fn().mockResolvedValue({ data: { id: 'msg-456' }, error: null });
    const notifier = makeNotifier({ send });

    const result = await notifier.notifyHelpWantedFilled(baseFill);
    expect(result).toEqual({ delivered: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]!.subject).toContain('Role filled');
  });

  it('returns delivered:false on missing maintainerEmail', async () => {
    const send = vi.fn();
    const notifier = makeNotifier({ send });
    const result = await notifier.notifyHelpWantedFilled({
      ...baseFill,
      maintainerEmail: null,
    });
    expect(result).toEqual({ delivered: false });
    expect(send).not.toHaveBeenCalled();
  });
});
