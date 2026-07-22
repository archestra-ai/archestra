"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { UseSubscriptionDialog } from "@/components/use-subscription-dialog";
import type { SubscriptionEntry } from "@/lib/subscriptions";

/**
 * Shown wherever a subscription is already selected but the viewer has no
 * credential of their own for it — the case that silently produces "invalid API
 * key" on the first send. The subscription resolves per-user at request time,
 * so someone else having connected it does not help this viewer.
 *
 * The sign-in happens here rather than behind a link to settings: the user is
 * mid-task, and bouncing them to another screen is how they get lost.
 */
export function SubscriptionSignInCta({
  entry,
  onConnected,
}: {
  entry: SubscriptionEntry;
  onConnected?: (apiKeyId: string) => void;
}) {
  const [signInOpen, setSignInOpen] = useState(false);

  return (
    <Alert className="border-amber-500/30 bg-amber-500/5">
      <KeyRound className="h-4 w-4" />
      <AlertTitle>Sign in to {entry.title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <span className="text-sm text-muted-foreground">
          {entry.signInUnavailable
            ? `Your administrator hasn't enabled ${entry.title} sign-in yet. Pick another model until they do.`
            : `This runs on each person's own ${entry.title} plan, and you haven't connected yours yet.`}
        </span>
        {!entry.signInUnavailable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSignInOpen(true)}
          >
            Sign in
          </Button>
        )}
      </AlertDescription>
      <UseSubscriptionDialog
        open={signInOpen}
        onOpenChange={setSignInOpen}
        providers={[entry.provider]}
        title={`Sign in to ${entry.title}`}
        description="Connect your own account. Usage counts against your plan, not the organization's."
        onConnected={(apiKeyId) => {
          onConnected?.(apiKeyId);
          setSignInOpen(false);
        }}
      />
    </Alert>
  );
}
