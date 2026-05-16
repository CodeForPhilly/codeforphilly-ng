import { Link } from 'react-router';

export function NotFound() {
  return (
    <div className="container mx-auto px-4 py-16 text-center">
      <h1 className="text-4xl font-bold text-foreground mb-4">404</h1>
      <p className="text-xl text-muted-foreground mb-6">
        Page not found.
      </p>
      <Link to="/" className="text-primary hover:underline">
        &larr; Back to home
      </Link>
    </div>
  );
}
