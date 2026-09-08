/**
 * Tests for PostmarkTransport (apps/api/src/notify/postmark-transport.ts).
 *
 * Two layers:
 *  - unit: a stub `sendEmail` proves the OutboundEmail → Postmark Message
 *    field mapping and that SDK errors propagate (the notifier owns
 *    catch-and-log, so the transport must not swallow them).
 *  - integration: the real `ServerClient` against an MSW intercept of
 *    `POST https://api.postmarkapp.com/email`, so a change in the SDK's
 *    wire format or auth header would surface here rather than in prod.
 */
import { ServerClient } from 'postmark';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PostmarkTransport } from '../src/notify/postmark-transport.js';
import { createPostmarkMock } from './helpers/mocks.js';

const email = {
  from: 'Code for Philly <notifications@codeforphilly.org>',
  to: 'maintainer@example.com',
  subject: 'Hello',
  text: 'plain body',
  html: '<p>html body</p>',
};

describe('PostmarkTransport (unit)', () => {
  it('maps OutboundEmail onto the Postmark Message shape and returns MessageID', async () => {
    const sendEmail = vi.fn().mockResolvedValue({
      To: email.to,
      SubmittedAt: '2026-09-08T00:00:00Z',
      MessageID: 'pm-123',
      ErrorCode: 0,
      Message: 'OK',
    });
    const transport = new PostmarkTransport({ client: { sendEmail } });

    const result = await transport.send(email);
    expect(result).toEqual({ messageId: 'pm-123' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0]).toEqual({
      From: email.from,
      To: email.to,
      Subject: 'Hello',
      TextBody: 'plain body',
      HtmlBody: '<p>html body</p>',
      MessageStream: 'outbound',
    });
  });

  it('honours an explicit messageStream', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ MessageID: 'pm-1', SubmittedAt: '', ErrorCode: 0, Message: 'OK' });
    const transport = new PostmarkTransport({ client: { sendEmail }, messageStream: 'notifications' });
    await transport.send(email);
    expect(sendEmail.mock.calls[0]![0].MessageStream).toBe('notifications');
  });

  it('propagates SDK errors untouched', async () => {
    const boom = Object.assign(new Error('Inactive recipient'), { code: 406, statusCode: 422 });
    const sendEmail = vi.fn().mockRejectedValue(boom);
    const transport = new PostmarkTransport({ client: { sendEmail } });
    await expect(transport.send(email)).rejects.toBe(boom);
  });
});

describe('PostmarkTransport (real ServerClient over MSW)', () => {
  const mock = createPostmarkMock();
  beforeAll(() => mock.server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => {
    mock.server.resetHandlers();
    mock.sentEmails.length = 0;
  });
  afterAll(() => mock.server.close());

  it('POSTs the expected JSON body to /email', async () => {
    const transport = new PostmarkTransport({ client: new ServerClient('test-server-token') });
    const result = await transport.send(email);

    expect(result.messageId).toMatch(/^mock-/);
    expect(mock.sentEmails).toHaveLength(1);
    expect(mock.sentEmails[0]).toEqual({
      From: email.from,
      To: email.to,
      Subject: 'Hello',
      TextBody: 'plain body',
      HtmlBody: '<p>html body</p>',
      MessageStream: 'outbound',
    });
  });
});
