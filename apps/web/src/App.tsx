import { BrowserRouter, Route, Routes } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppShell } from '@/components/AppShell';
import { NetworkErrorProvider } from '@/components/NetworkErrorBanner';
import { AuthProvider } from '@/hooks/useAuth';
import { HomeStub } from '@/pages/HomeStub';
import { ComingSoon } from '@/pages/ComingSoon';
import { NotFound } from '@/pages/NotFound';
import { LoginPlaceholder } from '@/pages/LoginPlaceholder';

export function App() {
  return (
    <BrowserRouter>
      <TooltipProvider>
        <NetworkErrorProvider>
          <AuthProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<HomeStub />} />
                <Route path="/projects" element={<ComingSoon />} />
                <Route path="/projects/:slug" element={<ComingSoon />} />
                <Route path="/projects/:slug/edit" element={<ComingSoon />} />
                <Route path="/projects/create" element={<ComingSoon />} />
                <Route path="/help-wanted" element={<ComingSoon />} />
                <Route path="/members" element={<ComingSoon />} />
                <Route path="/members/:slug" element={<ComingSoon />} />
                <Route path="/volunteer" element={<ComingSoon />} />
                <Route path="/sponsor" element={<ComingSoon />} />
                <Route path="/account" element={<ComingSoon />} />
                <Route path="/chat" element={<ComingSoon />} />
                <Route path="/search" element={<ComingSoon />} />
                <Route path="/pages/:slug" element={<ComingSoon />} />
                <Route path="/contact" element={<ComingSoon />} />
                <Route path="/tags/:namespace/:slug" element={<ComingSoon />} />
                <Route path="/login" element={<LoginPlaceholder />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </AuthProvider>
        </NetworkErrorProvider>
      </TooltipProvider>
    </BrowserRouter>
  );
}
