/**
 * BlogPostService — read operations.
 *
 * Per specs/api/blog.md. Writes happen via PR to the data repo, not the
 * runtime — no mutation methods here.
 */
import type { BlogPost, Tag } from '@cfp/shared/schemas';
import type { InMemoryState } from '../store/memory/state.js';
import { serializeBlogPost, type BlogPostResponse } from './serializers/blog-post.js';

export interface BlogPostListOptions {
  readonly page?: number;
  readonly perPage?: number;
  readonly since?: string;
  readonly tag?: string[];
}

export class BlogPostService {
  readonly #state: InMemoryState;

  constructor(state: InMemoryState) {
    this.#state = state;
  }

  list(opts: BlogPostListOptions): { items: BlogPostResponse[]; totalItems: number } {
    // Tag filter — map handles → post ids via TagAssignment.taggableType=blog-post.
    let filterPostIds: Set<string> | undefined;
    if (opts.tag && opts.tag.length > 0) {
      filterPostIds = new Set();
      for (const handle of opts.tag) {
        const tagId = this.#state.tagIdByHandle.get(handle);
        if (!tagId) continue;
        const taIds = this.#state.tagAssignmentsByTag.get(tagId) ?? new Set();
        for (const taId of taIds) {
          const ta = this.#state.tagAssignments.get(taId);
          if (ta?.taggableType === 'blog_post') filterPostIds.add(ta.taggableId);
        }
      }
    }

    const posts = [...this.#state.blogPosts.values()].filter((p) => {
      if (p.deletedAt) return false;
      if (opts.since && p.postedAt < opts.since) return false;
      if (filterPostIds && !filterPostIds.has(p.id)) return false;
      return true;
    });

    posts.sort((a, b) => b.postedAt.localeCompare(a.postedAt));

    const totalItems = posts.length;
    const page = Math.max(1, opts.page ?? 1);
    const perPage = Math.min(100, Math.max(1, opts.perPage ?? 20));
    const slice = posts.slice((page - 1) * perPage, page * perPage);

    const items = slice.map((p) => this.#serialize(p));
    return { items, totalItems };
  }

  findBySlug(slug: string): BlogPostResponse | null {
    const id = this.#state.blogPostIdBySlug.get(slug);
    if (!id) return null;
    const post = this.#state.blogPosts.get(id);
    if (!post || post.deletedAt) return null;
    return this.#serialize(post);
  }

  #serialize(post: BlogPost): BlogPostResponse {
    const author = post.authorId ? (this.#state.people.get(post.authorId) ?? null) : null;
    return serializeBlogPost(post, { author, tags: this.#tagsFor(post.id) });
  }

  #tagsFor(postId: string): Tag[] {
    const taIds = this.#state.tagAssignmentsByTaggable.get(postId) ?? new Set<string>();
    return [...taIds]
      .map((taId) => this.#state.tagAssignments.get(taId))
      .filter((ta): ta is NonNullable<typeof ta> => ta?.taggableType === 'blog_post')
      .map((ta) => this.#state.tags.get(ta.tagId))
      .filter((t): t is Tag => t !== undefined);
  }
}
