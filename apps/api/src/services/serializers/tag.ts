/**
 * Tag serializer.
 */
import type { Tag, TagAssignment } from '@cfp/shared/schemas';

export interface TagResponse {
  readonly id: string;
  readonly handle: string;
  readonly namespace: string;
  readonly slug: string;
  readonly title: string;
  readonly projectCount: number;
  readonly personCount: number;
  readonly helpWantedCount: number;
}

export function serializeTag(
  tag: Tag,
  opts: {
    tagAssignments: TagAssignment[];
  },
): TagResponse {
  let projectCount = 0;
  let personCount = 0;
  let helpWantedCount = 0;

  for (const ta of opts.tagAssignments) {
    if (ta.tagId !== tag.id) continue;
    if (ta.taggableType === 'project') projectCount++;
    else if (ta.taggableType === 'person') personCount++;
    else if (ta.taggableType === 'help_wanted_role') helpWantedCount++;
  }

  return {
    id: tag.id,
    handle: `${tag.namespace}.${tag.slug}`,
    namespace: tag.namespace,
    slug: tag.slug,
    title: tag.title,
    projectCount,
    personCount,
    helpWantedCount,
  };
}
