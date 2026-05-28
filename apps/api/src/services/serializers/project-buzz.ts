/**
 * ProjectBuzz serializer.
 */
import type { Person, Project, ProjectBuzz } from '@cfp/shared/schemas';
import type { BuzzPermissions } from '../permissions.js';
import { renderMarkdown, serializePersonAvatar } from './common.js';

export interface ProjectBuzzResponse {
  readonly id: string;
  readonly slug: string;
  readonly project: { readonly slug: string; readonly title: string };
  readonly postedBy: { readonly slug: string; readonly fullName: string; readonly avatarUrl: string | null } | null;
  readonly headline: string;
  readonly url: string;
  readonly publishedAt: string;
  readonly summary: string | null;
  readonly summaryHtml: string;
  readonly imageUrl: string | null;
  readonly permissions: BuzzPermissions;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeProjectBuzz(
  buzz: ProjectBuzz,
  opts: {
    project: Project;
    postedBy: Person | null;
    permissions: BuzzPermissions;
  },
): ProjectBuzzResponse {
  const summaryHtml = buzz.summary ? renderMarkdown(buzz.summary).html : '';

  return {
    id: buzz.id,
    slug: buzz.slug,
    project: { slug: opts.project.slug, title: opts.project.title },
    postedBy: serializePersonAvatar(opts.postedBy),
    headline: buzz.headline,
    url: buzz.url,
    publishedAt: buzz.publishedAt,
    summary: buzz.summary ?? null,
    summaryHtml,
    imageUrl: buzz.imageKey ? `/api/attachments/${buzz.imageKey}` : null,
    permissions: opts.permissions,
    createdAt: buzz.createdAt,
    updatedAt: buzz.updatedAt,
  };
}
