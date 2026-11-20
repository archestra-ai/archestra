"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import {
  IMPERSONATION_ENDED_TEXT,
  impersonationEndedNotice,
} from "@/lib/impersonation-ended-notice";

/**
 * Says why viewing as another user ended, on the page that shows after it.
 * Render it after the `Toaster`: a toast raised before the toaster listens
 * is never shown, and effects run in the order of the tree.
 */
export function ImpersonationEndedNotice() {
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
