import { useState } from 'react';
import { Link, NavLink } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { SearchBox } from '@/components/SearchBox';
import { useAuth } from '@/hooks/useAuth';

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
        aria-label="Loading auth state"
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
        <Button
          variant="ghost"
          size="sm"
          className="flex items-center gap-1"
          aria-label="About menu"
        >
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

export function AppHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow-sm print:hidden">
      <div className="container mx-auto flex h-14 items-center px-4 gap-4">
        {/* Logo */}
        <Link
          to="/"
          className="flex items-center gap-2 shrink-0"
          aria-label="Code for Philly home"
        >
          <img src="/img/logo.png" alt="" height={32} className="h-8 w-auto" />
          <span className="hidden md:inline font-semibold text-foreground">
            Code for Philly
          </span>
        </Link>

        {/* Desktop nav */}
        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center gap-1 ml-4 flex-1"
        >
          <NavLink to="/projects" className={navLinkClass}>
            Projects
          </NavLink>
          <NavLink
            to="/help-wanted"
            className={({ isActive }) => navLinkClass({ isActive }) + ' ml-1'}
          >
            Help Wanted
          </NavLink>
          <NavLink
            to="/members"
            className={({ isActive }) => navLinkClass({ isActive }) + ' ml-1'}
          >
            Members
          </NavLink>
          <Button asChild size="sm" className="ml-1 bg-green-600 hover:bg-green-700 text-white">
            <NavLink to="/volunteer">Volunteer</NavLink>
          </Button>
          <div className="ml-1">
            <AboutDropdown />
          </div>
        </nav>

        {/* Desktop: search + auth */}
        <div className="hidden md:flex items-center gap-2 ml-auto">
          <SearchBox />
          <AuthControls />
        </div>

        {/* Mobile: auth + hamburger */}
        <div className="flex md:hidden items-center gap-2 ml-auto">
          <AuthControls />
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Open navigation menu"
                aria-expanded={mobileOpen}
              >
                <MenuIcon />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 flex flex-col gap-4 pt-8">
              <nav
                aria-label="Mobile navigation"
                className="flex flex-col gap-2"
              >
                <NavLink
                  to="/projects"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Projects
                </NavLink>
                <NavLink
                  to="/help-wanted"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Help Wanted
                </NavLink>
                <NavLink
                  to="/members"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Members
                </NavLink>
                <NavLink
                  to="/volunteer"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Volunteer
                </NavLink>
                <Separator />
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  About
                </p>
                <NavLink
                  to="/pages/mission"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Mission
                </NavLink>
                <NavLink
                  to="/pages/leadership"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Leadership
                </NavLink>
                <NavLink
                  to="/pages/code-of-conduct"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Code of Conduct
                </NavLink>
                <NavLink
                  to="/pages/hackathons"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Hackathons
                </NavLink>
                <NavLink
                  to="/sponsor"
                  className={navLinkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  Sponsor
                </NavLink>
                <a
                  href="mailto:hello@codeforphilly.org"
                  className="text-sm font-medium text-muted-foreground hover:text-primary"
                >
                  Contact
                </a>
              </nav>
              <Separator />
              <SearchBox inline />
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
