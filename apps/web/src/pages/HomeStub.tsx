export function HomeStub() {
  return (
    <div className="container mx-auto px-4 py-16 text-center">
      <h1 className="text-4xl font-bold text-foreground mb-4">
        Code for Philly is being rebuilt
      </h1>
      <p className="text-lg text-muted-foreground max-w-xl mx-auto">
        We are modernizing the platform. Check back soon for the full
        experience. In the meantime, you can browse our projects below.
      </p>
      <div className="mt-8 flex justify-center gap-4">
        <a
          href="/projects"
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-6 py-3 text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Browse Projects
        </a>
        <a
          href="https://github.com/CodeForPhilly/codeforphilly-rewrite"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-md border border-border bg-background px-6 py-3 text-sm font-medium hover:bg-accent transition-colors"
        >
          View Source
        </a>
      </div>
    </div>
  );
}
