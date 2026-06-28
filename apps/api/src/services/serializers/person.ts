/**
 * Person serializers: PersonListItem and Person (detail) shapes.
 */
import type {
  Person,
  Project,
  ProjectMembership,
  ProjectUpdate,
  Tag,
  TagAssignment,
} from '@cfp/shared/schemas';
import type { PersonPermissions } from '../permissions.js';
import { renderMarkdown } from './common.js';
import {
  groupTagsByNamespace,
  serializePersonAvatar,
  truncate,
  type TagItem,
} from './common.js';

export interface PersonListItem {
  readonly slug: string;
  readonly fullName: string;
  readonly avatarUrl: string | null;
  readonly bioExcerpt: string;
  readonly memberOfCount: number;
  readonly tags: TagItem[];
  readonly createdAt: string;
}

export interface PersonMembershipSummary {
  readonly project: {
    readonly slug: string;
    readonly title: string;
    readonly stage: string;
  };
  readonly role: string | null;
  readonly isMaintainer: boolean;
  readonly joinedAt: string;
}

export interface ProjectUpdateSummary {
  readonly id: string;
  readonly number: number;
  readonly project: { readonly slug: string; readonly title: string };
  readonly bodyHtml: string;
  readonly createdAt: string;
}

export interface PersonDetail {
  readonly id: string;
  readonly slug: string;
  readonly fullName: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly avatarUrl: string | null;
  readonly bio: string | null;
  readonly bioHtml: string;
  readonly accountLevel: string;
  readonly slackHandle: string | null;
  /**
   * Set to the target's email for self/staff callers; null otherwise.
   * Per specs/screens/person-detail.md authorization table.
   */
  readonly email: string | null;
  readonly tags: { topic: TagItem[]; tech: TagItem[] };
  readonly memberships: PersonMembershipSummary[];
  readonly recentUpdates: ProjectUpdateSummary[];
  readonly permissions: PersonPermissions;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Set when the person is deactivated; visible to staff and self callers only. */
  readonly deletedAt: string | null;
}

export function serializePersonListItem(
  person: Person,
  opts: {
    memberOfCount: number;
    tagAssignments: TagAssignment[];
    allTags: Map<string, Tag>;
  },
): PersonListItem {
  const personTags = opts.tagAssignments
    .filter((ta) => ta.taggableType === 'person' && ta.taggableId === person.id)
    .map((ta) => opts.allTags.get(ta.tagId))
    .filter((t): t is Tag => t !== undefined);

  const bioExcerpt = person.bio
    ? truncate(renderMarkdown(person.bio).excerpt, 200)
    : '';

  return {
    slug: person.slug,
    fullName: person.fullName,
    avatarUrl: person.avatarKey ? `/api/attachments/${person.avatarKey}` : null,
    bioExcerpt,
    memberOfCount: opts.memberOfCount,
    tags: personTags.map((t) => ({ namespace: t.namespace, slug: t.slug, title: t.title })),
    createdAt: person.createdAt,
  };
}

export function serializePersonDetail(
  person: Person,
  opts: {
    memberships: ProjectMembership[];
    projectsMap: Map<string, Project>;
    recentUpdates: ProjectUpdate[];
    updatesProjectsMap: Map<string, Project>;
    tagAssignments: TagAssignment[];
    allTags: Map<string, Tag>;
    permissions: PersonPermissions;
    /** Caller's accountLevel — used to decide how much accountLevel to expose. */
    callerAccountLevel?: 'user' | 'staff' | 'administrator';
    callerPersonId?: string;
    /**
     * The target's email, when the caller is allowed to see it (self or
     * staff). The service is responsible for the gating + private-store
     * read; the serializer just passes through whatever's supplied.
     */
    visibleEmail?: string | null;
  },
): PersonDetail {
  const bioHtml = person.bio ? renderMarkdown(person.bio).html : '';

  const personTags = opts.tagAssignments
    .filter((ta) => ta.taggableType === 'person' && ta.taggableId === person.id)
    .map((ta) => opts.allTags.get(ta.tagId))
    .filter((t): t is Tag => t !== undefined);

  const tagsByNamespace = groupTagsByNamespace(personTags);

  const memberships: PersonMembershipSummary[] = opts.memberships.map((m) => {
    const project = opts.projectsMap.get(m.projectId);
    return {
      project: {
        slug: project?.slug ?? '',
        title: project?.title ?? '',
        stage: project?.stage ?? 'commenting',
      },
      role: m.role ?? null,
      isMaintainer: m.isMaintainer,
      joinedAt: m.joinedAt,
    };
  });

  const recentUpdates: ProjectUpdateSummary[] = opts.recentUpdates.slice(0, 5).map((u) => {
    const project = opts.updatesProjectsMap.get(u.projectId);
    return {
      id: u.id,
      number: u.number,
      project: { slug: project?.slug ?? '', title: project?.title ?? '' },
      bodyHtml: renderMarkdown(u.body).html,
      createdAt: u.createdAt,
    };
  });

  // accountLevel is visible to self and staff; everyone else sees "user"
  const isSelf = opts.callerPersonId === person.id;
  const callerIsStaff =
    opts.callerAccountLevel === 'staff' || opts.callerAccountLevel === 'administrator';
  const visibleAccountLevel =
    isSelf || callerIsStaff ? person.accountLevel : 'user';

  const avatar = serializePersonAvatar(person);

  return {
    id: person.id,
    slug: person.slug,
    fullName: person.fullName,
    firstName: person.firstName ?? null,
    lastName: person.lastName ?? null,
    avatarUrl: avatar?.avatarUrl ?? null,
    bio: person.bio ?? null,
    bioHtml,
    accountLevel: visibleAccountLevel,
    slackHandle: person.slackHandle ?? null,
    email: opts.visibleEmail ?? null,
    tags: { topic: tagsByNamespace.topic, tech: tagsByNamespace.tech },
    memberships,
    recentUpdates,
    permissions: opts.permissions,
    createdAt: person.createdAt,
    updatedAt: person.updatedAt,
    // deletedAt is visible to self and staff; everyone else gets null.
    deletedAt: (isSelf || callerIsStaff) ? (person.deletedAt ?? null) : null,
  };
}
