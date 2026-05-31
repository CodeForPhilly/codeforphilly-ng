/**
 * EmailNotifier — Resend-backed implementation of the Notifier interface.
 *
 * Sends help-wanted notifications via the Resend HTTPS API. Delivery
 * failures are logged but never thrown — per
 * `specs/api/projects-help-wanted.md`, the express-interest endpoint
 * returns 202 to the caller regardless of downstream notification
 * outcome.
 *
 * Slack DM is deliberately out of scope here (tracked at #95); this is
 * the email-only first cut. The Notifier interface still accepts
 * `maintainerSlackHandle` so the data flow is ready when Slack lands.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Resend } from 'resend';

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

export interface EmailNotifierOptions {
  /** Resend client (constructed at boot with the API key from env). */
  readonly resend: Resend;
  /** Sender address — RFC 5322 form, e.g. `"Code for Philly <notifications@…>"`. */
  readonly fromAddress: string;
  /** Public site host (no scheme), used to construct absolute URLs in email bodies. */
  readonly siteHost: string;
  /** Pino-style logger; only level methods are used. */
  readonly logger: FastifyBaseLogger;
}

export class EmailNotifier implements Notifier {
  readonly #resend: Resend;
  readonly #from: string;
  readonly #siteHost: string;
  readonly #log: FastifyBaseLogger;

  constructor(opts: EmailNotifierOptions) {
    this.#resend = opts.resend;
    this.#from = opts.fromAddress;
    this.#siteHost = opts.siteHost;
    this.#log = opts.logger;
  }

  async notifyHelpWantedInterest(
    n: HelpWantedInterestNotification,
  ): Promise<{ delivered: boolean }> {
    if (!n.maintainerEmail) {
      this.#log.warn(
        { kind: 'help-wanted.interest', projectSlug: n.projectSlug, roleId: n.roleId },
        'help-wanted interest: no maintainer email; skipped',
      );
      return { delivered: false };
    }
    const tpl = renderInterestEmail(n, this.#siteHost);
    try {
      const result = await this.#resend.emails.send({
        from: this.#from,
        to: n.maintainerEmail,
        subject: tpl.subject,
        text: tpl.text,
        html: tpl.html,
      });
      if (result.error) {
        this.#log.error(
          {
            kind: 'help-wanted.interest',
            err: result.error,
            projectSlug: n.projectSlug,
            roleId: n.roleId,
          },
          'help-wanted interest: Resend reported delivery failure',
        );
        return { delivered: false };
      }
      this.#log.info(
        {
          kind: 'help-wanted.interest',
          projectSlug: n.projectSlug,
          roleId: n.roleId,
          resendId: result.data?.id,
        },
        'help-wanted interest: email queued for delivery',
      );
      return { delivered: true };
    } catch (err) {
      this.#log.error(
        {
          kind: 'help-wanted.interest',
          err,
          projectSlug: n.projectSlug,
          roleId: n.roleId,
        },
        'help-wanted interest: email send threw',
      );
      return { delivered: false };
    }
  }

  async notifyWelcomeOnSignup(n: WelcomeNotification): Promise<{ delivered: boolean }> {
    if (!n.email) {
      this.#log.warn(
        { kind: 'auth.welcome', slug: n.slug },
        'welcome: no email address; skipped',
      );
      return { delivered: false };
    }
    const tpl = renderWelcomeEmail(n, this.#siteHost);
    try {
      const result = await this.#resend.emails.send({
        from: this.#from,
        to: n.email,
        subject: tpl.subject,
        text: tpl.text,
        html: tpl.html,
      });
      if (result.error) {
        this.#log.error(
          { kind: 'auth.welcome', err: result.error, slug: n.slug },
          'welcome: Resend reported delivery failure',
        );
        return { delivered: false };
      }
      this.#log.info(
        { kind: 'auth.welcome', slug: n.slug, resendId: result.data?.id },
        'welcome: email queued for delivery',
      );
      return { delivered: true };
    } catch (err) {
      this.#log.error(
        { kind: 'auth.welcome', err, slug: n.slug },
        'welcome: email send threw',
      );
      return { delivered: false };
    }
  }

  async notifyPasswordReset(n: PasswordResetNotification): Promise<{ delivered: boolean }> {
    if (!n.email) {
      this.#log.warn(
        { kind: 'auth.password-reset', slug: n.slug },
        'password-reset: no email address; skipped',
      );
      return { delivered: false };
    }
    const tpl = renderPasswordResetEmail(n, this.#siteHost);
    try {
      const result = await this.#resend.emails.send({
        from: this.#from,
        to: n.email,
        subject: tpl.subject,
        text: tpl.text,
        html: tpl.html,
      });
      if (result.error) {
        this.#log.error(
          { kind: 'auth.password-reset', err: result.error, slug: n.slug },
          'password-reset: Resend reported delivery failure',
        );
        return { delivered: false };
      }
      this.#log.info(
        { kind: 'auth.password-reset', slug: n.slug, resendId: result.data?.id },
        'password-reset: email queued for delivery',
      );
      return { delivered: true };
    } catch (err) {
      this.#log.error(
        { kind: 'auth.password-reset', err, slug: n.slug },
        'password-reset: email send threw',
      );
      return { delivered: false };
    }
  }

  async notifyHelpWantedFilled(
    n: HelpWantedFillNotification,
  ): Promise<{ delivered: boolean }> {
    if (!n.maintainerEmail) {
      this.#log.warn(
        { kind: 'help-wanted.filled', projectTitle: n.projectTitle },
        'help-wanted fill: no maintainer email; skipped',
      );
      return { delivered: false };
    }
    const tpl = renderFilledEmail(n, this.#siteHost);
    try {
      const result = await this.#resend.emails.send({
        from: this.#from,
        to: n.maintainerEmail,
        subject: tpl.subject,
        text: tpl.text,
        html: tpl.html,
      });
      if (result.error) {
        this.#log.error(
          { kind: 'help-wanted.filled', err: result.error, projectTitle: n.projectTitle },
          'help-wanted fill: Resend reported delivery failure',
        );
        return { delivered: false };
      }
      this.#log.info(
        {
          kind: 'help-wanted.filled',
          projectTitle: n.projectTitle,
          resendId: result.data?.id,
        },
        'help-wanted fill: email queued for delivery',
      );
      return { delivered: true };
    } catch (err) {
      this.#log.error(
        { kind: 'help-wanted.filled', err, projectTitle: n.projectTitle },
        'help-wanted fill: email send threw',
      );
      return { delivered: false };
    }
  }
}
