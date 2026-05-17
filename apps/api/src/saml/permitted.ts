/**
 * `samlSlackUserIsPermitted` — the IdP-side "may this person sign into Slack?"
 * hook from the legacy `IdentityConsumerTrait`.
 *
 * Default: every Person with `accountLevel` of `user`, `staff`, or
 * `administrator` is permitted. The legacy code paths Code for Philly used
 * (laddr `IdentityConsumerTrait::userIsPermitted`) had no further gating; we
 * preserve that surface so future deploys can substitute their own predicate
 * without touching route code.
 */
import type { Person } from '@cfp/shared/schemas';

export type SamlSlackUserIsPermitted = (person: Person) => boolean;

export const defaultSamlSlackUserIsPermitted: SamlSlackUserIsPermitted = (person) => {
  if (person.deletedAt) return false;
  return (
    person.accountLevel === 'user' ||
    person.accountLevel === 'staff' ||
    person.accountLevel === 'administrator'
  );
};
