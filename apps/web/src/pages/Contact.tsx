export function Contact() {
  return (
    <div className="container mx-auto px-4 py-12 max-w-2xl">
      <h1 className="text-3xl font-bold mb-4">Contact</h1>
      <p className="text-muted-foreground leading-relaxed">
        Email us at{' '}
        <a
          href="mailto:hello@codeforphilly.org"
          className="text-primary underline hover:no-underline"
        >
          hello@codeforphilly.org
        </a>
        .
      </p>
      <p className="text-muted-foreground mt-4">
        For real-time chat, join our{' '}
        <a href="/chat" className="text-primary underline hover:no-underline">
          Slack workspace
        </a>
        .
      </p>
    </div>
  );
}
