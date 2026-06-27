import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Pagination } from '@/components/Pagination';
import { TagChip } from '@/components/TagChip';
import { api } from '@/lib/api';
import type { BlogPostResponse } from '@/lib/api';

export function BlogIndex() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1);
  const tags = params.getAll('tag');

  const listQ = useQuery({
    queryKey: ['blog-posts', { tags, page }],
    queryFn: () =>
      api.blogPosts.list({
        tag: tags.length ? tags : undefined,
        page,
        perPage: 20,
      }),
  });

  const data = listQ.data?.data ?? [];
  const meta = listQ.data?.metadata;
  const totalPages = meta?.totalPages ?? 1;
  const hasFilters = tags.length > 0;

  const updateParams = useCallback(
    (mutate: (p: URLSearchParams) => void, resetPage = true) => {
      const next = new URLSearchParams(params);
      mutate(next);
      if (resetPage) next.delete('page');
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  const handleClearTags = useCallback(() => {
    updateParams((p) => p.delete('tag'));
  }, [updateParams]);

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Blog</h1>
        <p className="text-muted-foreground mt-2">
          Long-form posts from the Code for Philly community.
        </p>
        {hasFilters && (
          <div className="flex items-center gap-2 mt-3 flex-wrap text-sm">
            <span className="text-muted-foreground">Filters:</span>
            {tags.map((handle) => {
              const [ns, ...slugParts] = handle.split('.');
              const slug = slugParts.join('.');
              return (
                <TagChip
                  key={handle}
                  tag={{ namespace: ns ?? 'topic', slug, title: slug }}
                  onClick={() =>
                    updateParams((p) => {
                      const cur = p.getAll('tag').filter((c) => c !== handle);
                      p.delete('tag');
                      for (const c of cur) p.append('tag', c);
                    })
                  }
                />
              );
            })}
            <button
              onClick={handleClearTags}
              className="text-primary underline ml-2"
              type="button"
            >
              Clear filter
            </button>
          </div>
        )}
      </header>

      {listQ.isLoading && (
        <p className="text-muted-foreground">Loading posts…</p>
      )}

      {listQ.isError && (
        <p className="text-destructive">Couldn't load blog posts. Try again later.</p>
      )}

      {!listQ.isLoading && !listQ.isError && data.length === 0 && (
        <p className="text-muted-foreground">
          {hasFilters ? 'No posts match your filter.' : 'No blog posts yet.'}
        </p>
      )}

      <ul className="space-y-6">
        {data.map((post) => (
          <BlogIndexCard key={post.id} post={post} />
        ))}
      </ul>

      {totalPages > 1 && (
        <div className="mt-8">
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={(next) =>
              updateParams((p) => {
                if (next === 1) p.delete('page');
                else p.set('page', String(next));
              }, false)
            }
          />
        </div>
      )}
    </div>
  );
}

function BlogIndexCard({ post }: { post: BlogPostResponse }) {
  return (
    <li className="border-b border-border pb-6 last:border-b-0">
      <article className="flex gap-4">
        {post.featuredImageUrl && (
          <img
            src={post.featuredImageUrl}
            alt=""
            className="w-32 h-32 object-cover rounded-md flex-shrink-0"
          />
        )}
        <div className="flex-1">
          <h2 className="text-xl font-semibold">
            <Link to={`/blog/${post.slug}`} className="hover:text-primary">
              {post.title}
            </Link>
          </h2>
          <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
            {post.author ? (
              <>
                <Link
                  to={`/members/${post.author.slug}`}
                  className="hover:text-primary"
                >
                  {post.author.fullName}
                </Link>
                <span>·</span>
              </>
            ) : null}
            <time dateTime={post.postedAt}>{formatPostedAt(post.postedAt)}</time>
          </div>
          {(() => {
            // blog-index.md Display Rules: show `summary`; if absent, fall back
            // to the first paragraph of bodyHtml truncated to ~280 chars.
            const text = post.summary ?? excerptFromHtml(post.bodyHtml);
            return text ? (
              <p className="text-muted-foreground mt-2 leading-relaxed">{text}</p>
            ) : null;
          })()}
        </div>
      </article>
    </li>
  );
}

/**
 * Plain-text excerpt from already-sanitized post HTML: the first paragraph's
 * text, truncated to ~280 chars at a word boundary. Only strips tags for the
 * preview — the full post renders via the server-sanitized HTML elsewhere.
 */
function excerptFromHtml(html: string): string {
  const firstParagraph = /<p[^>]*>(.*?)<\/p>/is.exec(html)?.[1] ?? html;
  const text = firstParagraph.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (text.length <= 280) return text;
  return text.slice(0, 280).replace(/\s+\S*$/, '') + '…';
}

function formatPostedAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
