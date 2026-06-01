import { Outlet } from 'react-router';
import { AppHeader } from '@/components/AppHeader';
import { AppFooter } from '@/components/AppFooter';
import { ConnectGitHubBanner } from '@/components/ConnectGitHubBanner';
import { OfflineBanner } from '@/components/OfflineBanner';
import { TopProgressBar } from '@/components/TopProgressBar';

export function AppShell() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Skip to main content — must be the first focusable element */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded focus:shadow-lg focus:outline-none"
      >
        Skip to main content
      </a>

      <TopProgressBar />
      <OfflineBanner />
      <AppHeader />
      <ConnectGitHubBanner />

      <main id="main-content" className="flex-1" tabIndex={-1}>
        <Outlet />
      </main>

      <AppFooter />
    </div>
  );
}
