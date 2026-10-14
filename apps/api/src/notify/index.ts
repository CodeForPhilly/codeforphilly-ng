/**
 * Notification fan-out for help-wanted side-effects.
 *
 * v1 ships with email + slack-DM channels; Slack DM is stubbed until the
 * Slack integration exists. Failures are logged but never fail the request —
 * the spec says express-interest returns 202 to the caller regardless.
 *
 * The email transport is also stubbed; this module exists so the
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

/**
 * Password-reset notification — fires from `POST /api/auth/password-reset/request`
 * when the requested user resolves to a Person with an email on file. The
 * `token` is the plaintext (the private store keeps only its hash); it
 * leaves the system only via this email send.
 */
export interface PasswordResetNotification {
  readonly email: string;
  readonly fullName: string;
  readonly slug: string;
  readonly token: string;
  /** Expiry timestamp (ISO 8601), surfaced in the email body. */
  readonly expiresAt: string;
}

/**
 * The event facts every event email shows. `when` is pre-formatted in
 * Philadelphia time (specs/behaviors/events.md#time); `url` is canonical.
 */
export interface EventEmailFacts {
  readonly slug: string;
  readonly title: string;
  readonly when: string;
  readonly venueName: string | null;
  readonly venueAddress: string | null;
  readonly onlineUrl: string | null;
  readonly url: string;
}

/** RSVP confirmation — carries the `.ics` as an attachment plus the Google link. */
export interface EventRsvpNotification {
  readonly email: string;
  readonly fullName: string;
  readonly event: EventEmailFacts;
  readonly ics: string;
  readonly googleCalendarUrl: string;
}

/** "Event updated" — time or place changed after people RSVP'd. */
export interface EventUpdatedNotification {
  readonly email: string;
  readonly fullName: string;
  readonly event: EventEmailFacts;
  readonly changes: ReadonlyArray<{ readonly field: string; readonly from: string | null; readonly to: string | null }>;
  readonly ics: string;
}

/** "Cancelled" — with the staff note, if any. */
export interface EventCancelledNotification {
  readonly email: string;
  readonly fullName: string;
  readonly event: EventEmailFacts;
  readonly note: string | null;
  readonly ics: string;
}

export interface Notifier {
  notifyHelpWantedInterest(n: HelpWantedInterestNotification): Promise<{ delivered: boolean }>;
  notifyHelpWantedFilled(n: HelpWantedFillNotification): Promise<{ delivered: boolean }>;
  notifyWelcomeOnSignup(n: WelcomeNotification): Promise<{ delivered: boolean }>;
  notifyPasswordReset(n: PasswordResetNotification): Promise<{ delivered: boolean }>;
  notifyEventRsvp(n: EventRsvpNotification): Promise<{ delivered: boolean }>;
  notifyEventUpdated(n: EventUpdatedNotification): Promise<{ delivered: boolean }>;
  notifyEventCancelled(n: EventCancelledNotification): Promise<{ delivered: boolean }>;
}

/**
 * Default no-op notifier — logs the intent and returns delivered:true.
 * Replaced at boot by EmailNotifier when POSTMARK_SERVER_TOKEN is set; the
 * Slack transport is still to come (#95).
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

  async notifyPasswordReset(n: PasswordResetNotification): Promise<{ delivered: boolean }> {
    // Log the slug + email but NOT the token — even in dev logs, we don't
    // want plaintext password-reset tokens persisted anywhere. The token
    // is visible via the live email channel only.
    this.#log.info(
      { kind: 'auth.password-reset', email: n.email, slug: n.slug, expiresAt: n.expiresAt },
      'password-reset notification (token redacted)',
    );
    return { delivered: true };
  }

  async notifyEventRsvp(n: EventRsvpNotification): Promise<{ delivered: boolean }> {
    this.#log.info({ kind: 'event.rsvp', email: n.email, event: n.event.slug }, 'event RSVP confirmation');
    return { delivered: true };
  }

  async notifyEventUpdated(n: EventUpdatedNotification): Promise<{ delivered: boolean }> {
    this.#log.info(
      { kind: 'event.updated', email: n.email, event: n.event.slug, changes: n.changes },
      'event updated notification',
    );
    return { delivered: true };
  }

  async notifyEventCancelled(n: EventCancelledNotification): Promise<{ delivered: boolean }> {
    this.#log.info({ kind: 'event.cancelled', email: n.email, event: n.event.slug }, 'event cancelled notification');
    return { delivered: true };
  }
}
