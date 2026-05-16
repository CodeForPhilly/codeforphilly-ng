import { createBrowserRouter, RouterProvider } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/AppShell';
import { NetworkErrorProvider } from '@/components/NetworkErrorBanner';
import { AuthProvider } from '@/hooks/useAuth';
import { HomeStub } from '@/pages/HomeStub';
import { ComingSoon } from '@/pages/ComingSoon';
import { NotFound } from '@/pages/NotFound';
import { LoginPlaceholder } from '@/pages/LoginPlaceholder';

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomeStub /> },
      { path: '/projects', element: <ComingSoon /> },
      { path: '/projects/create', element: <ComingSoon /> },
      { path: '/projects/:slug', element: <ComingSoon /> },
      { path: '/projects/:slug/edit', element: <ComingSoon /> },
      { path: '/help-wanted', element: <ComingSoon /> },
      { path: '/members', element: <ComingSoon /> },
      { path: '/members/:slug', element: <ComingSoon /> },
      { path: '/volunteer', element: <ComingSoon /> },
      { path: '/sponsor', element: <ComingSoon /> },
      { path: '/account', element: <ComingSoon /> },
      { path: '/chat', element: <ComingSoon /> },
      { path: '/search', element: <ComingSoon /> },
      { path: '/pages/:slug', element: <ComingSoon /> },
      { path: '/contact', element: <ComingSoon /> },
      { path: '/tags/:namespace/:slug', element: <ComingSoon /> },
      { path: '/login', element: <LoginPlaceholder /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

export function App() {
  return (
    <TooltipProvider>
      <NetworkErrorProvider>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </NetworkErrorProvider>
    </TooltipProvider>
  );
}
