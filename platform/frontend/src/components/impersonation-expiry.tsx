"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/lib/auth/auth.query";
import {
  IMPERSONATION_RETURN_MARGIN_MS,
  useStopImpersonating,
} from "@/lib/impersonation.query";
import {
  IMPERSONATION_ENDED_TEXT,
  impersonationEndedNotice,
} from "@/lib/impersonation-ended-notice";

/** How long after an attempt that did not bring the admin back the app tries again. */
const RETURN_RETRY_MS = 15 * 1000;

/**
 * The end of viewing as another user, on every surface of the app: with
 * the banner or without it (an app's own page, a browser preview).
 *
 * An impersonated session has a fixed length. Left to run out, every request
 * is refused while the page still looks signed in, and the way back to the
 * admin's own session is gone with it. So the app returns shortly before
 * that, while it still can, and the page that shows next says why.
 *
 * Render it after the `Toaster`: a toast raised before the toaster listens
 * is never shown, and effects run in the order of the tree.
 */
export function ImpersonationExpiry() {
  const { data: session } = useSession();
  const { mutate: stopImpersonating } = useStopImpersonating();
  const expiresAt = session?.session.impersonatedBy
    ? new Date(session.session.expiresAt).getTime()
    : null;
  // When to try again, once an attempt was made.
  const [retryAt, setRetryAt] = useState<number | null>(null);

  useEffect(() => {
    if (expiresAt === null || Number.isNaN(expiresAt)) return;
    // A page shown inside another page of the app leaves the return to it.
    if (window.self !== window.top) return;
    const due = retryAt ?? expiresAt - IMPERSONATION_RETURN_MARGIN_MS;
    const timer = setTimeout(
      () => {
        // Whatever becomes of this attempt (a network error, a server fault,
        // or no answer at all), the next one follows while there is time. A
        // return that works reloads the page. A session that is really gone
        // is found by the session check the mutation asks for, which ends
        // this effect.
        setRetryAt(Date.now() + RETURN_RETRY_MS);
        stopImpersonating("expiring");
      },
      Math.max(due - Date.now(), 0),
    );
    return () => clearTimeout(timer);
  }, [expiresAt, retryAt, stopImpersonating]);

  useEffect(() => {
    const end = impersonationEndedNotice.take();
    if (end)
      toast.info(IMPERSONATION_ENDED_TEXT[end], {
        duration: 12000,
        id: "impersonation-ended",
      });
  }, []);

  return null;
}
