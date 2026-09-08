/**
 * EmailNotifier — transport-backed implementation of the Notifier interface.
 *
 * Renders each notification through the templates module and hands the
 * result to an `EmailTransport` (Postmark in production — see
 * `postmark-transport.ts`). Delivery failures are logged but never thrown —
 * per `specs/api/projects-help-wanted.md`, the express-interest endpoint
 * returns 202 to the caller regardless of downstream notification outcome,
 * and the auth routes fire-and-forget for the same reason.
 *
 * Slack DM is deliberately out of scope here (tracked at #95); this is
 * the email-only first cut. The Notifier interface still accepts
 * `maintainerSlackHandle` so the data flow is ready when Slack lands.
 */
import type { FastifyBaseLogger } from 'fastify';

import type {
  HelpWantedFillNotification,
  HelpWantedInterestNotification,
  Notifier,
  PasswordResetNotification,
  WelcomeNotification,
} from './index.js';
import {
  renderFilledEmail,
  renderInterestEmail,
  renderPasswordResetEmail,
  renderWelcomeEmail,
} from './templates.js';
import type { EmailTransport } from './transport.js';

/** Common shape of every template renderer's output. */
interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface EmailNotifierOptions {
  /** Provider adapter (constructed at boot from env; a stub in tests). */
  readonly transport: EmailTransport;
  /** Sender address — RFC 5322 form, e.g. `"Code for Philly <notifications@…>"`. */
  readonly fromAddress: string;
  /** Public site host (no scheme), used to construct absolute URLs in email bodies. */
  readonly siteHost: string;
  /** Pino-style logger; only level methods are used. */
  readonly logger: FastifyBaseLogger;
}

export class EmailNotifier implements Notifier {
  readonly #transport: EmailTransport;
  readonly #from: string;
  readonly #siteHost: string;
  readonly #log: FastifyBaseLogger;

  constructor(opts: EmailNotifierOptions) {
    this.#transport = opts.transport;
    this.#from = opts.fromAddress;
    this.#siteHost = opts.siteHost;
    this.#log = opts.logger;
  }

  async notifyHelpWantedInterest(
    n: HelpWantedInterestNotification,
  ): Promise<{ delivered: boolean }> {
    const ctx = { kind: 'help-wanted.interest', projectSlug: n.projectSlug, roleId: n.roleId };
    if (!n.maintainerEmail) {
      this.#log.warn(ctx, 'help-wanted interest: no maintainer email; skipped');
      return { delivered: false };
    }
    return this.#deliver(
      'help-wanted interest',
      ctx,
      n.maintainerEmail,
      renderInterestEmail(n, this.#siteHost),
    );
  }

  async notifyWelcomeOnSignup(n: WelcomeNotification): Promise<{ delivered: boolean }> {
    const ctx = { kind: 'auth.welcome', slug: n.slug };
    if (!n.email) {
      this.#log.warn(ctx, 'welcome: no email address; skipped');
      return { delivered: false };
    }
    return this.#deliver('welcome', ctx, n.email, renderWelcomeEmail(n, this.#siteHost));
  }

  async notifyPasswordReset(n: PasswordResetNotification): Promise<{ delivered: boolean }> {
    const ctx = { kind: 'auth.password-reset', slug: n.slug };
    if (!n.email) {
      this.#log.warn(ctx, 'password-reset: no email address; skipped');
      return { delivered: false };
    }
    return this.#deliver(
      'password-reset',
      ctx,
      n.email,
      renderPasswordResetEmail(n, this.#siteHost),
    );
  }

  async notifyHelpWantedFilled(
    n: HelpWantedFillNotification,
  ): Promise<{ delivered: boolean }> {
    const ctx = { kind: 'help-wanted.filled', projectTitle: n.projectTitle };
    if (!n.maintainerEmail) {
      this.#log.warn(ctx, 'help-wanted fill: no maintainer email; skipped');
      return { delivered: false };
    }
    return this.#deliver(
      'help-wanted fill',
      ctx,
      n.maintainerEmail,
      renderFilledEmail(n, this.#siteHost),
    );
  }

  /**
   * Shared send path. The transport's only failure shape is a throw (the
   * Postmark SDK raises on every non-2xx), so one catch covers network
   * blips and provider rejections alike; the `err` field carries the
   * provider's code/status for operators to tell them apart.
   */
  async #deliver(
    label: string,
    ctx: Record<string, unknown>,
    to: string,
    tpl: RenderedEmail,
  ): Promise<{ delivered: boolean }> {
    try {
      const { messageId } = await this.#transport.send({
        from: this.#from,
        to,
        subject: tpl.subject,
        text: tpl.text,
        html: tpl.html,
      });
      this.#log.info({ ...ctx, messageId }, `${label}: email queued for delivery`);
      return { delivered: true };
    } catch (err) {
      this.#log.error({ ...ctx, err }, `${label}: email send failed`);
      return { delivered: false };
    }
  }
}
