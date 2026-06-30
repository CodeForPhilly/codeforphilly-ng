/**
 * ProjectUpdate serializer.
 */
import type { Person, Project, ProjectUpdate } from '@cfp/shared/schemas';
import type { UpdatePermissions } from '../permissions.js';
import { renderMarkdown, serializePersonAvatar, type PersonAvatar } from './common.js';

export interface ProjectUpdateResponse {
  readonly id: string;
  readonly number: number;
  readonly project: { readonly slug: string; readonly title: string };
  readonly author: PersonAvatar | null;
  readonly body: string;
  readonly bodyHtml: string;
  readonly permissions: UpdatePermissions;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeProjectUpdate(
  update: ProjectUpdate,
  opts: {
    project: Project;
    author: Person | null;
    permissions: UpdatePermissions;
  },
): ProjectUpdateResponse {
  return {
    id: update.id,
    number: update.number,
    project: { slug: opts.project.slug, title: opts.project.title },
    author: serializePersonAvatar(opts.author),
    body: update.body,
    bodyHtml: renderMarkdown(update.body).html,
    permissions: opts.permissions,
    createdAt: update.createdAt,
    updatedAt: update.updatedAt,
  };
}
