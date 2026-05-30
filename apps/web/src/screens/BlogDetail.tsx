import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { MarkdownView } from '@/components/MarkdownView';
import { NotFound } from '@/pages/NotFound';
import { api } from '@/lib/api';

export function BlogDetail() {
  const { slug } = useParams<{ slug: string }>();
  const postQ = useQuery({
    queryKey: ['blog-post', slug],
    queryFn: () => (slug ? api.blogPosts.bySlug(slug) : Promise.reject(new Error('no slug'))),
    enabled: Boolean(slug),
    retry: false,
  });

  if (postQ.isLoading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-3xl">
        <p className="text-muted-foreground">Loading post…</p>
      </div>
    );
  }

  if (postQ.isError || !postQ.data) {
    return <NotFound />;
  }

  const post = postQ.data.data;
  const showEdited = post.editedAt && Math.abs(
    new Date(post.editedAt).getTime() - new Date(post.postedAt).getTime(),
  ) > 60_000;

  return (
    <article className="container mx-auto px-4 py-8 max-w-3xl">
      {post.featuredImageUrl && (
        <img
          src={post.featuredImageUrl}
          alt=""
          className="w-full max-h-96 object-cover rounded-md mb-6"
        />
      )}
      <header className="mb-6">
        <h1 className="text-3xl font-bold">{post.title}</h1>
        <div className="text-sm text-muted-foreground mt-2 flex items-center gap-2 flex-wrap">
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
          {showEdited && post.editedAt && (
            <>
              <span>·</span>
              <span title={post.editedAt}>Edited</span>
            </>
          )}
        </div>
      </header>

      <div className="mt-6">
        {post.bodyHtml ? <MarkdownView html={post.bodyHtml} /> : <p className="text-muted-foreground">—</p>}
      </div>

      <footer className="mt-10 pt-6 border-t border-border">
        <Link to="/blog" className="text-primary underline">
          ← Back to all posts
        </Link>
      </footer>
    </article>
  );
}

function formatPostedAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
