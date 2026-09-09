/**
 * PostmarkTransport — EmailTransport backed by the official `postmark` SDK.
 *
 * Postmark is the provider the legacy site already sends through, so the
 * `codeforphilly.org` sender signature is verified there (see
 * specs/architecture.md and docs/operations/secrets.md). The SDK throws a
 * `PostmarkError` subclass on every non-2xx response (bad token, inactive
 * recipient, rate limit, 5xx) and resolves with `{ MessageID, ... }` on
 * success — so this adapter needs no `{ error }` branch; a throw is the
 * only failure shape and the notifier catches it.
 */
import type { Message, Models } from 'postmark';

import type { EmailTransport, OutboundEmail } from './transport.js';

/** The slice of `postmark.ServerClient` this adapter touches. */
export interface PostmarkSender {
  sendEmail(email: Message): Promise<Models.MessageSendingResponse>;
}

export interface PostmarkTransportOptions {
  /** `new ServerClient(POSTMARK_SERVER_TOKEN)` at boot; anything with `sendEmail` in tests. */
  readonly client: PostmarkSender;
  /** Postmark message stream. Defaults to `outbound` (the transactional default stream). */
  readonly messageStream?: string;
}

export class PostmarkTransport implements EmailTransport {
  readonly #client: PostmarkSender;
  readonly #messageStream: string;

  constructor(opts: PostmarkTransportOptions) {
    this.#client = opts.client;
    this.#messageStream = opts.messageStream ?? 'outbound';
  }

  async send(email: OutboundEmail): Promise<{ messageId: string }> {
    const result = await this.#client.sendEmail({
      From: email.from,
      To: email.to,
      Subject: email.subject,
      TextBody: email.text,
      HtmlBody: email.html,
      MessageStream: this.#messageStream,
    });
    return { messageId: result.MessageID };
  }
}
