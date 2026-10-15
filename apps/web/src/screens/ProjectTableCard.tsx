import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';

/**
 * Printable table sign for a project (specs/screens/project-table-card.md):
 * a QR code to the project page, where a newcomer can sign in and join.
 */
export function ProjectTableCard() {
  const { slug = '' } = useParams<{ slug: string }>();
  const projectQ = useQuery({
    queryKey: ['project', slug],
    queryFn: () => api.projects.get(slug),
  });

  if (projectQ.isLoading) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading project…</div>;
  }

  if (projectQ.isError) {
    const err = projectQ.error;
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="container mx-auto px-4 py-16 text-center">
          <h1 className="text-2xl font-bold mb-2">Project not found</h1>
          <p className="text-muted-foreground mb-6">No project with the slug “{slug}” exists.</p>
          <Link to="/projects" className="text-primary hover:underline">
            ← Browse all projects
          </Link>
        </div>
      );
    }
    return <div className="container mx-auto px-4 py-12 text-destructive">Failed to load project.</div>;
  }

  const project = projectQ.data!.data;
  // The origin the card was opened on, so production prints codeforphilly.org
  // and a test instance prints its own host.
  const url = `${window.location.origin}/projects/${project.slug}`;
  const displayUrl = url.replace(/^https?:\/\//, '');

  return (
    <div className="container mx-auto px-4 py-8 print:p-0">
      <div className="flex items-center justify-center gap-3 mb-6 print:hidden">
        <Button onClick={() => window.print()}>Print</Button>
        <Button asChild variant="outline">
          <Link to={`/projects/${project.slug}`}>Back to project</Link>
        </Button>
      </div>

      <article className="mx-auto max-w-2xl rounded-lg border border-border bg-white text-black px-8 py-12 text-center print:max-w-none print:border-0 print:rounded-none print:py-0">
        <img
          src="/img/logo-horizontal.svg"
          alt="Code for Philly"
          className="mx-auto h-14 mb-10 print:h-20"
        />
        <h1 className="text-4xl font-bold leading-tight mb-3 print:text-5xl">{project.title}</h1>
        {project.summary && <p className="text-lg text-neutral-700 mb-8 line-clamp-2">{project.summary}</p>}
        <QRCodeSVG
          value={url}
          size={288}
          marginSize={0}
          title={`QR code for ${displayUrl}`}
          className="mx-auto my-8 h-[3in] w-[3in] print:my-12 print:h-[4in] print:w-[4in]"
        />
        <p className="text-3xl font-semibold mb-2 print:text-4xl">Scan to join this project</p>
        <p className="text-lg font-mono text-neutral-700 break-all">{displayUrl}</p>
        {project.links.chatChannel && (
          <p className="text-lg mt-6">
            Chat: <span className="font-semibold">#{project.links.chatChannel}</span> on the Code
            for Philly Slack
          </p>
        )}
      </article>
    </div>
  );
}
