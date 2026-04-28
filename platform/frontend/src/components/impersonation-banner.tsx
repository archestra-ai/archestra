"use client";

import { E2eTestId } from "@shared";
import { useSession } from "@/lib/auth/auth.query";
import { useStopImpersonating } from "@/lib/impersonation.query";
import { Button } from "./ui/button";

export function ImpersonationBanner() {
  const { data: session } = useSession();
  const { mutate: stopImpersonating, isPending } = useStopImpersonating();

  if (!session?.session.impersonatedBy) {
    return null;
  }

  const userName = session.user.name || session.user.email;

  return (
    <div
      data-testid={E2eTestId.ImpersonationBanner}
      className="bg-amber-100 dark:bg-amber-900/40 border-b border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-100 px-4 py-2 flex items-center justify-between gap-4"
    >
      <span className="text-sm font-medium">
        Viewing as <strong>{userName}</strong>. Permissions reflect that
        user&apos;s role.
      </span>
      <Button
        size="sm"
        variant="outline"
        data-testid={E2eTestId.ImpersonationStopButton}
        onClick={() => stopImpersonating()}
        disabled={isPending}
      >
        Return to admin
      </Button>
    </div>
  );
}
