import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/AppShell';
import { NetworkErrorProvider } from '@/components/NetworkErrorBanner';
import { AuthProvider } from '@/hooks/useAuth';
import { ApiQueryClientProvider } from '@/lib/queryClient';
import { Home } from '@/screens/Home';
import { ProjectsIndex } from '@/screens/ProjectsIndex';
import { ProjectDetail } from '@/screens/ProjectDetail';
import { ProjectEdit } from '@/screens/ProjectEdit';
import { PeopleIndex } from '@/screens/PeopleIndex';
import { PersonDetail } from '@/screens/PersonDetail';
import { ProfileEdit } from '@/screens/ProfileEdit';
import { Account } from '@/screens/Account';
import { HelpWantedIndex } from '@/screens/HelpWantedIndex';
import { ProjectUpdatesFeed } from '@/screens/ProjectUpdatesFeed';
import { ProjectBuzzFeed } from '@/screens/ProjectBuzzFeed';
import { TagsOverview } from '@/screens/TagsOverview';
import { TagsNamespace } from '@/screens/TagsNamespace';
import { TagDetail } from '@/screens/TagDetail';
import { Volunteer } from '@/screens/Volunteer';
import { Sponsor } from '@/screens/Sponsor';
import { ComingSoon } from '@/pages/ComingSoon';
import { NotFound } from '@/pages/NotFound';
import { LoginPlaceholder } from '@/pages/LoginPlaceholder';
import { AccountClaimPlaceholder } from '@/pages/AccountClaimPlaceholder';

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/projects', element: <ProjectsIndex /> },
      { path: '/projects/create', element: <ProjectEdit mode="create" /> },
      { path: '/projects/:slug', element: <ProjectDetail /> },
      { path: '/projects/:slug/edit', element: <ProjectEdit mode="edit" /> },
      { path: '/projects/:slug/updates/:number', element: <ProjectDetail anchor="update" /> },
      { path: '/projects/:slug/buzz/:buzzSlug', element: <ProjectDetail anchor="buzz" /> },
      { path: '/projects/:slug/buzz/new', element: <ComingSoon /> },
      { path: '/help-wanted', element: <HelpWantedIndex /> },
      { path: '/people', element: <Navigate to="/members" replace /> },
      { path: '/members', element: <PeopleIndex /> },
      { path: '/members/:slug', element: <PersonDetail /> },
      { path: '/members/:slug/edit', element: <ProfileEdit /> },
      { path: '/project-updates', element: <ProjectUpdatesFeed /> },
      { path: '/project-buzz', element: <ProjectBuzzFeed /> },
      { path: '/tags', element: <TagsOverview /> },
      { path: '/tags/:namespace', element: <TagsNamespace /> },
      { path: '/tags/:namespace/:slug', element: <TagDetail /> },
      { path: '/volunteer', element: <Volunteer /> },
      { path: '/sponsor', element: <Sponsor /> },
      { path: '/account', element: <Account /> },
      { path: '/search', element: <SearchRedirect /> },
      { path: '/pages/:slug', element: <ComingSoon /> },
      { path: '/contact', element: <ComingSoon /> },
      { path: '/login', element: <LoginPlaceholder /> },
      { path: '/account-claim', element: <AccountClaimPlaceholder /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

// /search?q=… isn't a separate page in v1 — redirect to /projects with the query preserved.
function SearchRedirect() {
  const q = new URLSearchParams(window.location.search).get('q');
  return <Navigate to={`/projects${q ? `?q=${encodeURIComponent(q)}` : ''}`} replace />;
}

export function App() {
  return (
    <TooltipProvider>
      <NetworkErrorProvider>
        <ApiQueryClientProvider>
          <AuthProvider>
            <RouterProvider router={router} />
            <Toaster richColors closeButton position="bottom-right" />
          </AuthProvider>
        </ApiQueryClientProvider>
      </NetworkErrorProvider>
    </TooltipProvider>
  );
}
