"use client";

import { E2eTestId } from "@archestra/shared";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/lib/auth/auth.query";
import {
  IMPERSONATION_RETURN_MARGIN_MS,
  impersonationEndedNotice,
  useStopImpersonating,
} from "@/lib/impersonation.query";
import { Button } from "./ui/button";

export function ImpersonationBanner() {
  const { data: session } = useSession();
  const { mutate: stopImpersonating, isPending } = useStopImpersonating();
  const expiresAt = session?.session.impersonatedBy
    ? new Date(session.session.expiresAt).getTime()
    : null;

  // An impersonated session has a fixed length. Left to run out, every
  // request is refused while the page still looks signed in, and the way
  // back to the admin's own session is gone with it. So the app returns
  // shortly before that, while it still can.
  useEffect(() => {
    if (expiresAt === null || Number.isNaN(expiresAt)) return;
    const timer = setTimeout(
      () => stopImpersonating("expiring"),
      Math.max(expiresAt - IMPERSONATION_RETURN_MARGIN_MS - Date.now(), 0),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, stopImpersonating]);

  // Back in the admin's own session after such a return: say why.
  useEffect(() => {
    if (impersonationEndedNotice.take())
      toast.info(
        "Viewing as another user ended: it lasts one hour at most. You are back in your own session.",
        { duration: 12000 },
      );
  }, []);

  // The end is a time of day on the reader's clock, so it is filled in on
  // their device, not on the server that rendered the page.
  const [until, setUntil] = useState<string | null>(null);
  useEffect(() => {
    setUntil(
      expiresAt === null || Number.isNaN(expiresAt)
        ? null
        : new Date(
            expiresAt - IMPERSONATION_RETURN_MARGIN_MS,
          ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    );
  }, [expiresAt]);

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
        <span>Viewing as </span>
        <strong>{userName}</strong>
        {until ? <span>{` until ${until}`}</span> : null}
        <span>. Permissions reflect that user&apos;s role.</span>
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
