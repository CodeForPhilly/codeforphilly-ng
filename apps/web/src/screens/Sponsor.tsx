import { useState } from 'react';
import { Button } from '@/components/ui/button';

const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'How much does it cost to sponsor?',
    a: 'Sponsorship tiers start at $500/year for an in-kind contribution and scale up to $25,000 for a Sustaining sponsorship. Get in touch and we’ll tailor a package to your goals.',
  },
  {
    q: 'What do we get?',
    a: 'Logo placement on the codeforphilly.org homepage and the hack-night welcome screen, a thank-you mention in our monthly newsletter, and the chance to present your work to the community.',
  },
  {
    q: 'Can we sponsor a specific project?',
    a: 'Yes. Project-restricted sponsorships fund a particular initiative directly. Talk to us about which projects could benefit from your support.',
  },
  {
    q: 'Are donations tax-deductible?',
    a: 'Code for Philly is a fiscally-sponsored project of a 501(c)(3) nonprofit, so donations are tax-deductible to the extent allowed by law.',
  },
  {
    q: 'Can our employees volunteer as part of the sponsorship?',
    a: 'Absolutely. Some sponsors run dedicated hack nights at their offices. We love that.',
  },
];

export function Sponsor() {
  const [copied, setCopied] = useState(false);
  const email = 'sponsor@codeforphilly.org';

  const handleCopy = () => {
    void navigator.clipboard.writeText(email).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div>
      <section className="bg-gradient-to-br from-primary/5 to-background border-b border-border">
        <div className="container mx-auto px-4 py-16 text-center">
          <h1 className="text-3xl md:text-5xl font-bold mb-4">Sponsor Code for Philly</h1>
          <p className="text-lg md:text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Help us put tech to work for Philadelphia's communities.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <a href={`mailto:${email}`}>Get in touch →</a>
            </Button>
          </div>
        </div>
      </section>

      <section className="container mx-auto px-4 py-12">
        <h2 className="text-2xl font-bold mb-6 text-center">Why sponsor?</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold mb-2">Visibility</h3>
            <p className="text-sm text-muted-foreground">
              Your logo and brand on the codeforphilly.org homepage and at our weekly hack nights.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold mb-2">Talent</h3>
            <p className="text-sm text-muted-foreground">
              Show our community of 1,000+ technologists what your team is working on.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="font-semibold mb-2">Civic impact</h3>
            <p className="text-sm text-muted-foreground">
              Underwrite work that makes Philadelphia better.
            </p>
          </div>
        </div>
      </section>

      <section className="bg-muted/30 border-y border-border">
        <div className="container mx-auto px-4 py-12">
          <h2 className="text-2xl font-bold mb-6 text-center">Current sponsors</h2>
          <p className="text-sm text-muted-foreground text-center">
            (Sponsor logos will be added here as partnerships are confirmed.)
          </p>
        </div>
      </section>

      <section className="container mx-auto px-4 py-12 max-w-3xl">
        <h2 className="text-2xl font-bold mb-6 text-center">FAQ</h2>
        <div className="space-y-2">
          {FAQ.map((item, idx) => (
            <details key={idx} className="rounded-lg border border-border bg-card p-4">
              <summary className="cursor-pointer font-semibold">{item.q}</summary>
              <p className="text-sm text-muted-foreground mt-2">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="bg-primary/5 border-t border-border">
        <div className="container mx-auto px-4 py-10 text-center">
          <h2 className="text-2xl font-bold mb-3">Ready to talk?</h2>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a href={`mailto:${email}`} className="text-lg text-primary hover:underline">
              {email}
            </a>
            <Button variant="outline" size="sm" onClick={handleCopy}>
              {copied ? 'Copied ✓' : 'Copy email'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
