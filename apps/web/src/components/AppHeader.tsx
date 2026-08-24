import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { SearchBox } from '@/components/SearchBox';
import { GitHubIcon } from '@/components/icons/GitHubIcon';
import { useAuth } from '@/hooks/useAuth';

const GITHUB_URL = 'https://github.com/CodeForPhilly';

function ChevronDownIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function AuthControls({ mobile = false }: { mobile?: boolean }) {
  const { person, loading, signOut } = useAuth();

  if (loading) {
    return (
      <div
        className={`h-8 ${mobile ? 'w-full' : 'w-20'} bg-muted animate-pulse rounded`}
        aria-hidden="true"
      />
    );
  }

  if (!person) {
    return (
      <Button asChild size={mobile ? 'default' : 'sm'} className={mobile ? 'w-full' : ''}>
        <Link to="/login">Sign in</Link>
      </Button>
    );
  }

  const avatarLetter = person.fullName.charAt(0).toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={`flex items-center gap-2 ${mobile ? 'w-full justify-start' : ''}`}
          aria-label={`Account menu for ${person.fullName}`}
        >
          {person.avatarUrl ? (
            <img
              src={person.avatarUrl}
              alt=""
              className="w-6 h-6 rounded-full"
            />
          ) : (
            <span className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center">
              {avatarLetter}
            </span>
          )}
          <span className="hidden sm:inline">{person.fullName}</span>
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link to={`/members/${person.slug}`}>My profile</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/account">Account settings</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={`/projects?memberSlug=${person.slug}`}>My projects</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {(person.accountLevel === 'staff' ||
          person.accountLevel === 'administrator') && (
          <>
            <DropdownMenuItem asChild>
              <Link to="/tags?staff=true">Manage tags</Link>
            </DropdownMenuItem>
            <DropdownMenuItem disabled>Recent staff actions</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {person.accountLevel === 'administrator' && (
          <>
            <DropdownMenuItem asChild>
              <Link to="/members?staff=true&accountLevel=all">
                Manage members
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => void signOut()}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AboutDropdown() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* No aria-label: the visible "About" text is the accessible name. */}
        <Button variant="ghost" size="sm" className="flex items-center gap-1">
          About <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem asChild>
          <Link to="/pages/mission">Mission</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/pages/leadership">Leadership</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/pages/code-of-conduct">Code of Conduct</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/pages/hackathons">Hackathons</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/sponsor">Sponsor</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="mailto:hello@codeforphilly.org">Contact</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm font-medium transition-colors hover:text-primary ${
    isActive ? 'text-primary' : 'text-muted-foreground'
  }`;

function GitHubLink() {
  return (
    // Desktop-only: between md and lg the header has no room for it (the
    // utility cluster would push "Help Wanted" onto two lines); the mobile
    // sheet carries its own GitHub row.
    <Button asChild variant="ghost" size="icon-sm" className="hidden lg:inline-flex">
      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Code for Philly on GitHub (opens in new tab)"
      >
        <GitHubIcon />
      </a>
    </Button>
  );
}

export function AppHeader() {
  const location = useLocation();
  // The sheet is open only for the location it was opened at, so any
  // client-side navigation — a NavLink or Enter in the inline search —
  // closes it without per-item onClick closers. Derived during render
  // rather than synced in an effect (react-hooks/set-state-in-effect).
  const [openedAtKey, setOpenedAtKey] = useState<string | null>(null);
  const mobileOpen = openedAtKey === location.key;
  const setMobileOpen = (open: boolean) =>
    setOpenedAtKey(open ? location.key : null);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm print:hidden">
      <div className="container mx-auto flex h-14 items-center px-4 gap-4">
        {/* Wordmark — always visible. The horizontal lockup includes
            the icon + text, so no separate text node is needed. */}
        <Link
          to="/"
          className="flex items-center shrink-0"
          aria-label="Code for Philly home"
        >
          <img
            src="/img/logo-horizontal.svg"
            alt="Code for Philly"
            className="h-12 w-auto"
          />
        </Link>

        {/* Desktop content cluster. The parent gap is the only source of
            spacing between children — no per-child margins. */}
        {/* A nav is a list of destinations — the <ul>/<li> is what tells a
            screen reader how many there are and where you are in them. The
            flex/gap spacing moves to the <ul>; the <li>s contribute none. */}
        <nav
          aria-label="Primary navigation"
          className="hidden md:block ml-4 flex-1"
        >
          <ul className="flex items-center gap-2">
            <li>
              <NavLink to="/projects" className={navLinkClass}>
                Projects
              </NavLink>
            </li>
            <li>
              <NavLink to="/help-wanted" className={navLinkClass}>
                Help Wanted
              </NavLink>
            </li>
            <li>
              <NavLink to="/members" className={navLinkClass}>
                Members
              </NavLink>
            </li>
            <li>
              <AboutDropdown />
            </li>
          </ul>
        </nav>

        {/* Desktop utility cluster: GitHub, search, auth, then the Volunteer
            CTA pinned rightmost (specs/behaviors/app-shell.md). */}
        <nav
          aria-label="Utility"
          className="hidden md:flex items-center gap-2 ml-auto"
        >
          <GitHubLink />
          <SearchBox />
          <AuthControls />
          <Button
            asChild
            size="sm"
            className="bg-green-600 hover:bg-green-700 text-white"
          >
            <NavLink to="/volunteer">Volunteer</NavLink>
          </Button>
        </nav>

        {/* Mobile: auth + hamburger */}
        <div className="flex md:hidden items-center gap-2 ml-auto">
          <AuthControls />
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              {/* No aria-expanded here — Radix's Dialog.Trigger supplies it. */}
              <Button
                variant="ghost"
                size="sm"
                aria-label="Open navigation menu"
              >
                <MenuIcon />
              </Button>
            </SheetTrigger>
            <SheetContent side="right">
              {/* SheetHeader/SheetTitle carry the panel's own padding and give
                  the underlying Radix dialog its accessible name; the
                  visually-hidden description satisfies aria-describedby. */}
              <SheetHeader className="pb-0">
                <SheetTitle>Menu</SheetTitle>
                <SheetDescription className="sr-only">
                  Site navigation
                </SheetDescription>
              </SheetHeader>
              {/* min-h-0 + overflow-y-auto so the list stays reachable on
                  short viewports instead of overflowing the panel. */}
              {/* Three lists with the separators and the group heading
                  between them, rather than one list interrupted by
                  non-list children. The nav keeps the flex column so the
                  gap-2 rhythm between groups is unchanged. */}
              <nav
                aria-label="Mobile navigation"
                className="flex flex-col gap-2 px-4 min-h-0 overflow-y-auto"
              >
                <ul className="flex flex-col gap-2">
                  <li>
                    <NavLink to="/projects" className={navLinkClass}>
                      Projects
                    </NavLink>
                  </li>
                  <li>
                    <NavLink to="/help-wanted" className={navLinkClass}>
                      Help Wanted
                    </NavLink>
                  </li>
                  <li>
                    <NavLink to="/members" className={navLinkClass}>
                      Members
                    </NavLink>
                  </li>
                </ul>
                <Separator />
                {/* SheetTitle ("Menu") renders a Radix DialogTitle, i.e. an
                    h2 — so this group label is an h3, not a styled <p>. */}
                <h3 className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  About
                </h3>
                <ul className="flex flex-col gap-2">
                  <li>
                    <NavLink to="/pages/mission" className={navLinkClass}>
                      Mission
                    </NavLink>
                  </li>
                  <li>
                    <NavLink to="/pages/leadership" className={navLinkClass}>
                      Leadership
                    </NavLink>
                  </li>
                  <li>
                    <NavLink to="/pages/code-of-conduct" className={navLinkClass}>
                      Code of Conduct
                    </NavLink>
                  </li>
                  <li>
                    <NavLink to="/pages/hackathons" className={navLinkClass}>
                      Hackathons
                    </NavLink>
                  </li>
                  <li>
                    <NavLink to="/sponsor" className={navLinkClass}>
                      Sponsor
                    </NavLink>
                  </li>
                  <li>
                    <a
                      href="mailto:hello@codeforphilly.org"
                      className="text-sm font-medium text-muted-foreground hover:text-primary"
                      onClick={() => setMobileOpen(false)}
                    >
                      Contact
                    </a>
                  </li>
                </ul>
                <Separator />
                <ul className="flex flex-col gap-2">
                  <li>
                    <a
                      href={GITHUB_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium text-muted-foreground hover:text-primary"
                      onClick={() => setMobileOpen(false)}
                    >
                      GitHub
                      <span className="sr-only"> (opens in new tab)</span>
                    </a>
                  </li>
                  <li>
                    <NavLink to="/volunteer" className={navLinkClass}>
                      Volunteer
                    </NavLink>
                  </li>
                </ul>
              </nav>
              <Separator />
              <div className="px-4 pb-4">
                <SearchBox inline />
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
