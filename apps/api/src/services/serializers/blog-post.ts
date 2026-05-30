/**
 * BlogPost serializer.
 */
import type { BlogPost, Person } from '@cfp/shared/schemas';
import { renderMarkdown, serializePersonAvatar, type PersonAvatar } from './common.js';

export interface BlogPostResponse {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly author: PersonAvatar | null;
  readonly postedAt: string;
  readonly editedAt: string | null;
  readonly featuredImageKey: string | null;
  readonly featuredImageUrl: string | null;
  readonly body: string;
  readonly bodyHtml: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeBlogPost(
  post: BlogPost,
  opts: { author: Person | null },
): BlogPostResponse {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    summary: post.summary ?? null,
    author: serializePersonAvatar(opts.author),
    postedAt: post.postedAt,
    editedAt: post.editedAt ?? null,
    featuredImageKey: post.featuredImageKey ?? null,
    featuredImageUrl: post.featuredImageKey
      ? `/api/attachments/${post.featuredImageKey}`
      : null,
    body: post.body,
    bodyHtml: renderMarkdown(post.body).html,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}
