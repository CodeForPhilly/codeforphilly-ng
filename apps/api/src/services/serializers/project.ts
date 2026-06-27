/**
 * Project serializers: ProjectListItem and Project (detail) shapes.
 */
import type {
  HelpWantedRole,
  Person,
  Project,
  ProjectMembership,
  Tag,
  TagAssignment,
} from '@cfp/shared/schemas';
import { renderMarkdown } from './common.js';
import type { ProjectPermissions } from '../permissions.js';
import {
  groupTagsByNamespace,
  serializePersonAvatar,
  serializeTagItem,
  truncate,
  type PersonAvatar,
  type TagItem,
} from './common.js';

export interface ProjectListItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly stage: string;
  readonly overviewExcerpt: string;
  readonly maintainer: PersonAvatar | null;
  readonly memberCount: number;
  readonly members: PersonAvatar[];
  readonly links: {
    readonly usersUrl: string | null;
    readonly developersUrl: string | null;
    readonly chatChannel: string | null;
  };
  readonly openHelpWantedCount: number;
  readonly tags: TagItem[];
  readonly updatedAt: string;
}

export interface ProjectMembershipResponse {
  readonly id: string;
  readonly projectSlug: string;
  readonly person: PersonAvatar;
  readonly role: string | null;
  readonly isMaintainer: boolean;
  readonly joinedAt: string;
}

export interface ProjectDetail {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly overview: string | null;
  readonly overviewHtml: string;
  readonly stage: string;
  readonly stageProgress: number;
  readonly maintainer: PersonAvatar | null;
  readonly memberships: ProjectMembershipResponse[];
  readonly openHelpWantedRoles: HelpWantedRoleSummary[];
  readonly tags: { topic: TagItem[]; tech: TagItem[]; event: TagItem[] };
  readonly links: {
    readonly usersUrl: string | null;
    readonly developersUrl: string | null;
    readonly chatChannel: string | null;
  };
  readonly counts: {
    readonly updates: number;
    readonly buzz: number;
    readonly members: number;
  };
  readonly permissions: ProjectPermissions;
  readonly featured: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface HelpWantedRoleSummary {
  readonly id: string;
  readonly title: string;
  readonly commitmentHoursPerWeek: number | null;
  readonly status: string;
  readonly tags: { topic: TagItem[]; tech: TagItem[] };
}

const STAGE_ORDER = [
  'commenting',
  'bootstrapping',
  'prototyping',
  'testing',
  'maintaining',
  'drifting',
  'hibernating',
] as const;

function stageProgress(stage: string): number {
  const idx = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  if (idx < 0) return 0;
  return idx / (STAGE_ORDER.length - 1);
}

export function serializeProjectListItem(
  project: Project,
  opts: {
    maintainer: Person | null;
    memberships: ProjectMembership[];
    memberPeople: Map<string, Person>;
    openHelpWantedCount: number;
    tags: Tag[];
    tagAssignments: TagAssignment[];
    allTags: Map<string, Tag>;
  },
): ProjectListItem {
  const { excerpt: rawExcerpt } = project.overview
    ? renderMarkdown(project.overview)
    : { excerpt: '' };

  const overviewExcerpt = truncate(rawExcerpt, 600);

  const projectTags = opts.tagAssignments
    .filter((ta) => ta.taggableType === 'project' && ta.taggableId === project.id)
    .map((ta) => opts.allTags.get(ta.tagId))
    .filter((t): t is Tag => t !== undefined);

  // First 10 members: maintainer first, then by fullName
  const sortedMemberships = [...opts.memberships].sort((a, b) => {
    if (a.personId === project.maintainerId) return -1;
    if (b.personId === project.maintainerId) return 1;
    const pa = opts.memberPeople.get(a.personId);
    const pb = opts.memberPeople.get(b.personId);
    return (pa?.fullName ?? '').localeCompare(pb?.fullName ?? '');
  });

  const members = sortedMemberships
    .slice(0, 10)
    .map((m) => opts.memberPeople.get(m.personId))
    .filter((p): p is Person => p !== undefined)
    .map(serializePersonAvatar)
    .filter((a): a is PersonAvatar => a !== null);

  return {
    id: project.id,
    slug: project.slug,
    title: project.title,
    summary: project.summary ?? null,
    stage: project.stage,
    overviewExcerpt,
    maintainer: serializePersonAvatar(opts.maintainer),
    memberCount: opts.memberships.length,
    members,
    links: {
      usersUrl: project.usersUrl ?? null,
      developersUrl: project.developersUrl ?? null,
      chatChannel: project.chatChannel ?? null,
    },
    openHelpWantedCount: opts.openHelpWantedCount,
    tags: projectTags.map(serializeTagItem),
    updatedAt: project.updatedAt,
  };
}

export function serializeProjectDetail(
  project: Project,
  opts: {
    maintainer: Person | null;
    memberships: ProjectMembership[];
    memberPeople: Map<string, Person>;
    openHelpWantedRoles: HelpWantedRole[];
    helpWantedTags: Map<string, Tag[]>;
    tags: Tag[];
    updateCount: number;
    buzzCount: number;
    permissions: ProjectPermissions;
  },
): ProjectDetail {
  const overviewHtml = project.overview ? renderMarkdown(project.overview).html : '';

  const tagsByNamespace = groupTagsByNamespace(opts.tags);

  const memberships: ProjectMembershipResponse[] = opts.memberships
    .sort((a, b) => {
      if (a.personId === project.maintainerId) return -1;
      if (b.personId === project.maintainerId) return 1;
      const pa = opts.memberPeople.get(a.personId);
      const pb = opts.memberPeople.get(b.personId);
      return (pa?.fullName ?? '').localeCompare(pb?.fullName ?? '');
    })
    .map((m) => {
      const person = opts.memberPeople.get(m.personId);
      return {
        id: m.id,
        projectSlug: project.slug,
        person: serializePersonAvatar(person) ?? {
          slug: '',
          fullName: 'Unknown',
          avatarUrl: null,
        },
        role: m.role ?? null,
        isMaintainer: m.isMaintainer,
        joinedAt: m.joinedAt,
      };
    });

  const openHelpWantedRoles: HelpWantedRoleSummary[] = opts.openHelpWantedRoles.map((role) => {
    const roleTags = opts.helpWantedTags.get(role.id) ?? [];
    const grouped = groupTagsByNamespace(roleTags);
    return {
      id: role.id,
      title: role.title,
      commitmentHoursPerWeek: role.commitmentHoursPerWeek ?? null,
      status: role.status,
      tags: { topic: grouped.topic, tech: grouped.tech },
    };
  });

  return {
    id: project.id,
    slug: project.slug,
    title: project.title,
    summary: project.summary ?? null,
    overview: project.overview ?? null,
    overviewHtml,
    stage: project.stage,
    stageProgress: stageProgress(project.stage),
    maintainer: serializePersonAvatar(opts.maintainer),
    memberships,
    openHelpWantedRoles,
    tags: tagsByNamespace,
    links: {
      usersUrl: project.usersUrl ?? null,
      developersUrl: project.developersUrl ?? null,
      chatChannel: project.chatChannel ?? null,
    },
    counts: {
      updates: opts.updateCount,
      buzz: opts.buzzCount,
      members: opts.memberships.length,
    },
    permissions: opts.permissions,
    featured: project.featured,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    deletedAt: project.deletedAt ?? null,
  };
}
