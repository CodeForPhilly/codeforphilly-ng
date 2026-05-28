/**
 * HelpWantedRole serializer.
 */
import type { HelpWantedRole, Person, Project, Tag, TagAssignment } from '@cfp/shared/schemas';
import type { HelpWantedPermissions } from '../permissions.js';
import { groupTagsByNamespace, renderMarkdown, serializePersonAvatar, type TagItem } from './common.js';

export interface HelpWantedRoleResponse {
  readonly id: string;
  readonly project: { readonly slug: string; readonly title: string };
  readonly postedBy: { readonly slug: string; readonly fullName: string; readonly avatarUrl: string | null } | null;
  readonly title: string;
  readonly description: string;
  readonly descriptionHtml: string;
  readonly commitmentHoursPerWeek: number | null;
  readonly status: string;
  readonly filledBy: { readonly slug: string; readonly fullName: string; readonly avatarUrl: string | null } | null;
  readonly filledAt: string | null;
  readonly closedAt: string | null;
  readonly tags: { topic: TagItem[]; tech: TagItem[] };
  readonly interestCount: number;
  readonly permissions: HelpWantedPermissions;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeHelpWantedRole(
  role: HelpWantedRole,
  opts: {
    project: Project;
    postedBy: Person | null;
    filledBy: Person | null;
    tagAssignments: TagAssignment[];
    allTags: Map<string, Tag>;
    interestCount: number;
    permissions: HelpWantedPermissions;
  },
): HelpWantedRoleResponse {
  const roleTags = opts.tagAssignments
    .filter((ta) => ta.taggableType === 'help_wanted_role' && ta.taggableId === role.id)
    .map((ta) => opts.allTags.get(ta.tagId))
    .filter((t): t is Tag => t !== undefined);

  const tagsByNamespace = groupTagsByNamespace(roleTags);

  return {
    id: role.id,
    project: { slug: opts.project.slug, title: opts.project.title },
    postedBy: serializePersonAvatar(opts.postedBy),
    title: role.title,
    description: role.description,
    descriptionHtml: renderMarkdown(role.description).html,
    commitmentHoursPerWeek: role.commitmentHoursPerWeek ?? null,
    status: role.status,
    filledBy: serializePersonAvatar(opts.filledBy),
    filledAt: role.filledAt ?? null,
    closedAt: role.closedAt ?? null,
    tags: { topic: tagsByNamespace.topic, tech: tagsByNamespace.tech },
    interestCount: opts.interestCount,
    permissions: opts.permissions,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}
