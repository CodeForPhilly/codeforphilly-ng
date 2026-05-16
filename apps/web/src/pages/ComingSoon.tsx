import { Link, useLocation } from 'react-router';

export function ComingSoon() {
  const location = useLocation();

  return (
    <div className="container mx-auto px-4 py-16 text-center">
      <h1 className="text-2xl font-bold text-foreground mb-3">Coming Soon</h1>
      <p className="text-muted-foreground mb-2">
        This section is under construction.
      </p>
      <p className="text-sm text-muted-foreground mb-6">
        <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
          {location.pathname}
        </code>
      </p>
      <Link
        to="/"
        className="text-sm text-primary hover:underline"
      >
        &larr; Back to home
      </Link>
    </div>
  );
}
