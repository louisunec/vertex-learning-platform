import { SignInButton } from "@clerk/nextjs";
import { Button, Card } from "@/components/ui";

/** Shown in place of learner-only content; returns to `returnTo` after sign-in. */
export function SignedOut({ message, returnTo }: { message: string; returnTo: string }) {
  return (
    <Card className="mt-10 flex flex-col items-start gap-4 p-6">
      <p className="text-body-lg text-neutral-700">{message}</p>
      <SignInButton mode="modal" forceRedirectUrl={returnTo} signUpForceRedirectUrl={returnTo}>
        <Button size="md">Sign in</Button>
      </SignInButton>
    </Card>
  );
}
