/**
 * EmailTransport — the one-method seam between the Notifier and whichever
 * provider actually delivers mail.
 *
 * `EmailNotifier` composes subject/text/html from templates and hands the
 * result here. The transport either resolves with a provider message id
 * or throws; it never swallows failures — the notifier owns the
 * log-and-return-`delivered: false` contract. Keeping the seam this narrow
 * means tests exercise the notifier with a `vi.fn()` and the provider
 * adapter (`postmark-transport.ts`) is the only file that knows a vendor.
 */
/** A file attached to an outbound email (the `.ics` on event mail). */
export interface EmailAttachment {
  readonly name: string;
  readonly contentType: string;
  /** Base64-encoded bytes. */
  readonly content: string;
}

export interface OutboundEmail {
  /** RFC 5322 sender, e.g. `"Code for Philly <notifications@…>"`. */
  readonly from: string;
  /** Single recipient address. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly attachments?: ReadonlyArray<EmailAttachment>;
}

export interface EmailTransport {
  /** Deliver one message. Resolves with the provider's message id; throws on any failure. */
  send(email: OutboundEmail): Promise<{ messageId: string }>;
}
