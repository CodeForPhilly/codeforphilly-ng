/**
 * BlogPost serializer.
 */
import type { BlogPost, Person, Tag } from '@cfp/shared/schemas';
import {
  renderMarkdown,
  serializePersonAvatar,
  serializeTagItem,
  type PersonAvatar,
  type TagItem,
} from './common.js';

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
  readonly tags: TagItem[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeBlogPost(
  post: BlogPost,
  opts: { author: Person | null; tags?: Tag[] },
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
    tags: (opts.tags ?? []).map(serializeTagItem),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
  };
}
