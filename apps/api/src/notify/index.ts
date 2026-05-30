/**
 * Notification fan-out for help-wanted side-effects.
 *
 * v1 ships with email + slack-DM channels; Slack DM is stubbed until the
 * Slack integration exists. Failures are logged but never fail the request —
 * the spec says express-interest returns 202 to the caller regardless.
 *
 * The Resend / email transport is also stubbed; this module exists so the
 * surface is in place for write-api to call and for tests to spy on.
 */
import type { FastifyBaseLogger } from 'fastify';

export interface HelpWantedInterestNotification {
  readonly maintainerEmail: string | null;
  readonly maintainerSlackHandle: string | null;
  readonly roleTitle: string;
  readonly projectTitle: string;
  readonly projectSlug: string;
  readonly roleId: string;
  readonly interestedPersonFullName: string;
  readonly interestedPersonSlug: string;
  readonly message: string | null;
}

export interface HelpWantedFillNotification {
  readonly maintainerEmail: string | null;
  readonly roleTitle: string;
  readonly projectTitle: string;
  readonly filledByFullName: string | null;
  readonly filledBySlug: string | null;
}

/**
 * Welcome notification — fires once per Person on the GitHub OAuth
 * `create-fresh` outcome (a brand-new signup with no laddr-account-claim
 * candidates). The email comes from the new PrivateProfile; fullName and
 * slug from the public Person record.
 */
export interface WelcomeNotification {
  readonly email: string;
  readonly fullName: string;
  readonly slug: string;
}

export interface Notifier {
  notifyHelpWantedInterest(n: HelpWantedInterestNotification): Promise<{ delivered: boolean }>;
  notifyHelpWantedFilled(n: HelpWantedFillNotification): Promise<{ delivered: boolean }>;
  notifyWelcomeOnSignup(n: WelcomeNotification): Promise<{ delivered: boolean }>;
}

/**
 * Default no-op notifier — logs the intent and returns delivered:true.
 * Replace with a real notifier once the Resend / Slack transports land.
 */
export class LoggingNotifier implements Notifier {
  readonly #log: FastifyBaseLogger;

  constructor(log: FastifyBaseLogger) {
    this.#log = log;
  }

  async notifyHelpWantedInterest(n: HelpWantedInterestNotification): Promise<{ delivered: boolean }> {
    this.#log.info({ kind: 'help-wanted.interest', ...n }, 'help-wanted interest notification');
    return { delivered: true };
  }

  async notifyHelpWantedFilled(n: HelpWantedFillNotification): Promise<{ delivered: boolean }> {
    this.#log.info({ kind: 'help-wanted.filled', ...n }, 'help-wanted fill notification');
    return { delivered: true };
  }

  async notifyWelcomeOnSignup(n: WelcomeNotification): Promise<{ delivered: boolean }> {
    this.#log.info({ kind: 'auth.welcome', ...n }, 'welcome notification');
    return { delivered: true };
  }
}
