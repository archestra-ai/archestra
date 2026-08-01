"use client";

import { useEffect } from "react";
import { LoadingSpinner } from "@/components/loading";
import { useSession } from "@/lib/auth/auth.query";
import { useTwoFactorChallengePending } from "@/lib/auth/two-factor.query";

type GuardVerdict = "allow" | "wait" | { redirectTo: string };

/**
 * Keeps the standalone two-factor pages from rendering to people they don't
 * apply to — someone typing /auth/two-factor while fully signed in, or with
 * no pending challenge at all.
 *
 * This is a UX gate, not the security boundary: the server refuses enrollment
 * without a session and refuses verification without the challenge cookie
 * regardless of what renders here.
 */
function useAuthRouteGuard(verdict: GuardVerdict) {
  const target = typeof verdict === "object" ? verdict.redirectTo : null;
  useEffect(() => {
    if (target) {
      // Full navigation: these transitions cross an auth-state boundary, so
      // the app should re-read the session from scratch.
      window.location.replace(target);
    }
  }, [target]);
}

function GuardShell({
  verdict,
  children,
}: {
  verdict: GuardVerdict;
  children: React.ReactNode;
}) {
  useAuthRouteGuard(verdict);
  if (verdict === "allow") {
    return <>{children}</>;
  }
  return (
    <div className="flex min-h-40 items-center justify-center">
      <LoadingSpinner />
    </div>
  );
}

/**
 * Enrollment surface: needs a signed-in user who has not enrolled yet.
 */
export function RequireEnrollableSession({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, isPending } = useSession();
  let verdict: GuardVerdict = "allow";
  if (isPending) {
    verdict = "wait";
  } else if (!session) {
    verdict = { redirectTo: "/auth/sign-in" };
  } else if (session.user.twoFactorEnabled) {
    verdict = { redirectTo: "/" };
  }
  return <GuardShell verdict={verdict}>{children}</GuardShell>;
}

/**
 * Sign-in challenge surface (code entry and backup-code recovery): needs a
 * half-finished sign-in — no full session, but a pending challenge.
 */
export function RequirePendingTwoFactorChallenge({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: challengePending, isPending: isChallengePending } =
    useTwoFactorChallengePending();

  let verdict: GuardVerdict = "allow";
  if (isSessionPending || isChallengePending) {
    verdict = "wait";
  } else if (session) {
    // Already signed in — there is nothing left to verify.
    verdict = { redirectTo: "/" };
  } else if (!challengePending) {
    verdict = { redirectTo: "/auth/sign-in" };
  }
  return <GuardShell verdict={verdict}>{children}</GuardShell>;
}
