import { Link } from 'react-router';

const CURRENT_YEAR = new Date().getFullYear();
const FOUNDED_YEAR = 2011;

// Social icon SVGs — inline for zero extra dependencies
function InstagramIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
      <rect x="2" y="9" width="4" height="12" />
      <circle cx="4" cy="4" r="2" />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  );
}

function MeetupIcon() {
  // Simplified Meetup-style icon (the M)
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <text x="3" y="18" fontSize="16" fontWeight="bold" fontFamily="sans-serif">M</text>
    </svg>
  );
}

function MastodonIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.327 8.566c0-4.339-2.843-5.61-2.843-5.61-1.433-.658-3.894-.935-6.451-.956h-.063c-2.557.021-5.016.298-6.45.956 0 0-2.843 1.272-2.843 5.61 0 .993-.019 2.181.012 3.441.103 4.243.778 8.425 4.701 9.463 1.809.479 3.362.579 4.612.51 2.268-.126 3.541-.809 3.541-.809l-.075-1.646s-1.621.511-3.441.449c-1.804-.062-3.707-.194-3.999-2.409a4.523 4.523 0 0 1-.04-.621s1.77.433 4.014.536c1.372.063 2.658-.08 3.965-.236 2.506-.299 4.688-1.843 4.962-3.254.434-2.223.398-5.424.398-5.424zm-3.353 5.59h-2.081V9.057c0-1.075-.452-1.62-1.357-1.62-1 0-1.501.647-1.501 1.927v2.791h-2.069V9.364c0-1.28-.501-1.927-1.502-1.927-.905 0-1.357.546-1.357 1.62v5.099H6.026V8.903c0-1.074.273-1.927.823-2.558.567-.631 1.307-.955 2.228-.955 1.065 0 1.872.409 2.405 1.228l.518.869.519-.869c.533-.819 1.34-1.228 2.405-1.228.92 0 1.661.324 2.228.955.549.631.822 1.484.822 2.558v5.253z" />
    </svg>
  );
}

function BlueskyIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8z" />
    </svg>
  );
}

const socials: Array<{ label: string; href: string; Icon: () => React.ReactElement }> = [
  {
    label: 'Code for Philly on Instagram',
    href: 'https://www.instagram.com/codeforphilly/',
    Icon: InstagramIcon,
  },
  {
    label: 'Code for Philly on LinkedIn',
    href: 'https://www.linkedin.com/company/code-for-philly/',
    Icon: LinkedInIcon,
  },
  {
    label: 'Code for Philly on Facebook',
    href: 'https://www.facebook.com/codeforphilly/',
    Icon: FacebookIcon,
  },
  {
    label: 'Code for Philly on Meetup',
    href: 'https://www.meetup.com/Code-for-Philly/',
    Icon: MeetupIcon,
  },
  {
    label: 'Code for Philly on Mastodon',
    href: 'https://mastodon.social/@codeforphilly',
    Icon: MastodonIcon,
  },
  {
    label: 'Code for Philly on Bluesky',
    href: 'https://bsky.app/profile/codeforphilly.org',
    Icon: BlueskyIcon,
  },
];

export function AppFooter() {
  return (
    <footer className="border-t border-border bg-muted/40 mt-auto print:hidden">
      <div className="container mx-auto px-4 py-10">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Column 1: Explore */}
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3">Explore</h2>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link to="/projects" className="hover:text-foreground transition-colors">
                  Active Projects
                </Link>
              </li>
              <li>
                <Link to="/projects/create" className="hover:text-foreground transition-colors">
                  Start a Project
                </Link>
              </li>
              <li>
                <Link to="/pages/hackathons" className="hover:text-foreground transition-colors">
                  Hackathons
                </Link>
              </li>
              <li>
                <Link to="/members" className="hover:text-foreground transition-colors">
                  Members
                </Link>
              </li>
              <li>
                <Link to="/help-wanted" className="hover:text-foreground transition-colors">
                  Help Wanted
                </Link>
              </li>
              <li>
                <Link to="/blog" className="hover:text-foreground transition-colors">
                  Blog
                </Link>
              </li>
            </ul>
          </div>

          {/* Column 2: About */}
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3">About</h2>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <Link to="/pages/mission" className="hover:text-foreground transition-colors">
                  Mission
                </Link>
              </li>
              <li>
                <Link to="/pages/leadership" className="hover:text-foreground transition-colors">
                  Leadership
                </Link>
              </li>
              <li>
                <Link to="/pages/code-of-conduct" className="hover:text-foreground transition-colors">
                  Code of Conduct
                </Link>
              </li>
              <li>
                <Link to="/sponsor" className="hover:text-foreground transition-colors">
                  Sponsor
                </Link>
              </li>
              <li>
                <a
                  href="mailto:hello@codeforphilly.org"
                  className="hover:text-foreground transition-colors"
                >
                  Contact
                </a>
              </li>
            </ul>
          </div>

          {/* Column 3: Connect */}
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-3">Connect</h2>
            <ul className="space-y-2 text-sm text-muted-foreground mb-4">
              <li>
                <Link to="/chat" className="hover:text-foreground transition-colors">
                  Slack
                </Link>
              </li>
            </ul>
            <div className="flex items-center gap-3 flex-wrap">
              {socials.map(({ label, href, Icon }) => (
                <a
                  key={href}
                  href={href}
                  aria-label={label}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Icon />
                </a>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom strip */}
        <div className="mt-8 pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
          <p>
            Copyright &copy; Code for Philly {FOUNDED_YEAR}&ndash;{CURRENT_YEAR}
          </p>
          <a
            href="https://github.com/CodeForPhilly/codeforphilly-rewrite"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground transition-colors"
          >
            Open source &mdash; view this site on GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
