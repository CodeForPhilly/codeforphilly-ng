import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { HelpWantedCard } from '@/components/HelpWantedCard';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/lib/api';

const HACK_NIGHT_URL =
  'https://codeforphilly.gitbook.io/projects/contributing-to-projects/hack-night-program-details';
const START_PROJECT_URL =
  'https://codeforphilly.gitbook.io/projects/creating-new-partnerships/first-steps';

export function Volunteer() {
  const { person } = useAuth();
  const countQ = useQuery({
    queryKey: ['projects-count'],
    queryFn: () => api.projects.list({ perPage: 1 }),
  });
  const rolesQ = useQuery({
    queryKey: ['volunteer-help-wanted', { perPage: 6 }],
    queryFn: () => api.helpWanted.list({ perPage: 6 }),
  });

  const projectCount = countQ.data?.metadata.totalItems ?? null;
  const projectCountLabel = projectCount !== null ? projectCount : 'hundreds of';

  return (
    <div>
      <section className="bg-gradient-to-br from-primary/5 to-background border-b border-border">
        <div className="container mx-auto px-4 py-16 text-center">
          <h1 className="text-3xl md:text-5xl font-bold mb-4">
            Volunteer with Code for Philly
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            No coding experience required. We have a project for you.
          </p>
          <Button asChild size="lg" className="bg-green-600 hover:bg-green-700 text-white">
            <Link to={person ? '/projects' : '/login?return=/volunteer'}>
              {person ? 'Browse projects →' : 'Create an account →'}
            </Link>
          </Button>
        </div>
      </section>

      <section className="container mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-6 text-center">How it works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold mb-2">1. Join Slack</h3>
            <p className="text-sm text-muted-foreground mb-3">
              We coordinate everything in our Slack workspace.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link to="/chat">Open Slack →</Link>
            </Button>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold mb-2">2. Pick a project</h3>
            <p className="text-sm text-muted-foreground mb-3">
              Browse {projectCountLabel} active projects and find one that matches your interests.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link to="/projects">Browse projects →</Link>
            </Button>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold mb-2">3. Show up to meetups</h3>
            <p className="text-sm text-muted-foreground mb-3">
              We meet weekly. Bring your laptop, or just yourself.
            </p>
            <Button asChild variant="outline" size="sm">
              <a href={HACK_NIGHT_URL} target="_blank" rel="noopener noreferrer">
                When we meet →
              </a>
            </Button>
          </div>
        </div>
      </section>

      {(rolesQ.data?.data ?? []).length > 0 && (
        <section className="bg-muted/30 border-y border-border">
          <div className="container mx-auto px-4 py-12">
            <div className="mb-6">
              <h2 className="text-2xl font-bold mb-1">Looking for a concrete way to help?</h2>
              <p className="text-muted-foreground">
                These projects have specific roles open right now:
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(rolesQ.data?.data ?? []).slice(0, 6).map((role) => (
                <HelpWantedCard key={role.id} role={role} />
              ))}
            </div>
            <div className="mt-6 text-right">
              <Link to="/help-wanted" className="text-primary hover:underline">
                See all open roles →
              </Link>
            </div>
          </div>
        </section>
      )}

      <section className="container mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-4">Not a coder?</h2>
        <p className="text-muted-foreground max-w-3xl mb-6">
          Code for Philly isn't just for developers. Designers, project managers, researchers, and community organizers all play vital roles.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold mb-2">Design & UX</h3>
            <p className="text-sm text-muted-foreground mb-3">
              Help shape how civic tools look and feel.
            </p>
            <Link to="/tags/topic/design" className="text-sm text-primary hover:underline">
              Design projects →
            </Link>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold mb-2">Research</h3>
            <p className="text-sm text-muted-foreground mb-3">
              Interview neighbors, analyze open data, document needs.
            </p>
            <Link to="/tags/topic/research" className="text-sm text-primary hover:underline">
              Research projects →
            </Link>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold mb-2">Community organizing</h3>
            <p className="text-sm text-muted-foreground mb-3">
              Help us connect with partner organizations and city programs.
            </p>
            <Link to="/tags/topic/civic-engagement" className="text-sm text-primary hover:underline">
              Civic engagement projects →
            </Link>
          </div>
        </div>
      </section>

      <section className="bg-primary/5 border-t border-border">
        <div className="container mx-auto px-4 py-10 text-center">
          <h2 className="text-2xl font-bold mb-3">Have an idea? Start your own project.</h2>
          <div className="flex flex-wrap justify-center gap-3">
            <Button asChild>
              <a href={START_PROJECT_URL} target="_blank" rel="noopener noreferrer">
                Read the guide →
              </a>
            </Button>
            <Button asChild variant="outline">
              <Link to={person ? '/projects/create' : '/login?return=/projects/create'}>
                Or create one on the site →
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
