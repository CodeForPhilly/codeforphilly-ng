import { useSearchParams } from 'react-router';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * Temporary landing page for the account-claim flow.
 *
 * The github-oauth plan ends with the callback issuing a claim-pending JWT
 * (cfp_claim cookie) and redirecting here. The full claim UI ships with the
 * account-claim plan; until then this page just tells the user what happened
 * and offers a "sign in fresh" escape hatch.
 */
export function AccountClaimPlaceholder() {
  const [searchParams] = useSearchParams();
  const returnPath = searchParams.get('return') ?? '/';

  return (
    <div className="flex justify-center py-16 px-4">
      <Card className="w-full max-w-[560px]">
        <CardHeader>
          <CardTitle>Almost there</CardTitle>
          <CardDescription>
            We recognized an existing Code for Philly account that might be
            yours.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>
            The account-claim flow is coming in the next release. Until then,
            this page is a placeholder.
          </p>
          <p className="text-muted-foreground">
            You signed in with GitHub successfully — we just need to confirm
            whether you want to connect to your existing legacy account or
            start a fresh profile. Check back soon, or sign in again to be
            taken straight to{' '}
            <span className="font-mono">{returnPath}</span>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
