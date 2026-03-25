"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect, useRef } from "react";
import { authClient } from "@/lib/clients/auth/auth-client";
import config from "@/lib/config/config";

export function PostHogProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const hasIdentifiedUserRef = useRef(false);
  const isPostHogInitializedRef = useRef(false);
  const lastIdentifiedUserIdRef = useRef<string | null>(null);
  const userId = session?.user?.id;
  const userEmail = session?.user?.email;
  const userName = session?.user?.name;

  useEffect(() => {
    const {
      enabled: analyticsEnabled,
      token,
      config: posthogConfig,
    } = config.posthog;

    if (analyticsEnabled) {
      posthog.init(token, posthogConfig);
      isPostHogInitializedRef.current = true;
    }
  }, []);

  useEffect(() => {
    const analyticsEnabled = config.posthog.enabled;
    if (
      !analyticsEnabled ||
      !isPostHogInitializedRef.current ||
      isSessionPending
    ) {
      return;
    }

    if (userId && userId !== lastIdentifiedUserIdRef.current && userEmail) {
      posthog.identify(userId, {
        email: userEmail,
        name: userName || userEmail,
      });
      hasIdentifiedUserRef.current = true;
      lastIdentifiedUserIdRef.current = userId;
      return;
    } else if (userId) {
      return;
    }

    if (hasIdentifiedUserRef.current) {
      posthog.reset();
      hasIdentifiedUserRef.current = false;
      lastIdentifiedUserIdRef.current = null;
    }
  }, [isSessionPending, userEmail, userId, userName]);

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
