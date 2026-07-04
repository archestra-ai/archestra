"use client";

import { FEEDBACK_TYPEFORM_URL } from "@archestra/shared";
import type { Permissions } from "@archestra/shared/permission.types";
import posthog from "posthog-js";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useFeedbackPopupActivation,
  useMarkNavItemsSeen,
  useSeenNavItems,
} from "@/lib/onboarding/onboarding.query";

/**
 * One-time "share feedback" nudge for admins. Shows on the first session that
 * STARTED after activation (an MCP server connected and a successful tool
 * call routed), and never again once interacted with — "Share feedback",
 * "Not now" and plain dismissal all count. The per-user marker rides the
 * onboarding seen-items store.
 */
export function FeedbackPopupDialog() {
  const { data: isAdmin } = useHasPermissions(FEEDBACK_ADMIN_PERMISSION);
  const { data: session } = useSession();
  const { data: seenData, isSuccess: seenLoaded } = useSeenNavItems();
  const { data: activation } = useFeedbackPopupActivation({
    enabled: isAdmin === true,
  });
  const { mutate: markItemsSeen } = useMarkNavItemsSeen();
  const appName = useAppName();
  const [dismissed, setDismissed] = useState(false);

  const sessionStartedAt = session?.session?.createdAt;
  // "Next session after activation": the current session must have started
  // after both activation signals existed.
  const activatedBeforeThisSession =
    activation?.activatedAt != null &&
    sessionStartedAt != null &&
    new Date(activation.activatedAt) < new Date(sessionStartedAt);

  const open =
    isAdmin === true &&
    seenLoaded &&
    !(seenData?.items ?? []).includes(FEEDBACK_POPUP_SEEN_KEY) &&
    !dismissed &&
    activatedBeforeThisSession;

  useEffect(() => {
    if (open) posthog.capture("feedback_popup_viewed");
  }, [open]);

  const dismiss = () => {
    setDismissed(true);
    markItemsSeen([FEEDBACK_POPUP_SEEN_KEY]);
  };

  const shareFeedback = () => {
    window.open(FEEDBACK_TYPEFORM_URL, "_blank", "noopener,noreferrer");
    dismiss();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) dismiss();
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-sm">
        <div className="relative flex flex-col items-center px-8 pt-10 pb-8 text-center">
          {/* Soft wash in the org's primary color behind the greeting */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-primary/10 to-transparent"
          />
          <div className="relative flex size-14 items-center justify-center rounded-full bg-primary/10 text-3xl">
            <span aria-hidden className="feedback-wave">
              👋
            </span>
          </div>
          <DialogHeader className="mt-4 space-y-2">
            <DialogTitle className="text-xl font-semibold tracking-tight">
              Help shape {appName}
            </DialogTitle>
            <DialogDescription className="text-sm leading-relaxed">
              Looks like you've been putting {appName} to work! We're the people
              building it, and we'd love to hear what's working and what's
              missing.
            </DialogDescription>
          </DialogHeader>
          <Button size="lg" className="mt-6 w-full" onClick={shareFeedback}>
            Share feedback <span aria-hidden>→</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 text-muted-foreground"
            onClick={dismiss}
          >
            Not now
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// === Internal ===

const FEEDBACK_POPUP_SEEN_KEY = "feedback:popup";

const FEEDBACK_ADMIN_PERMISSION: Permissions = {
  organizationSettings: ["update"],
};
