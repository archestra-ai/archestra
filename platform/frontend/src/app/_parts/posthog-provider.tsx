"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect, useRef } from "react";
import { authClient } from "@/lib/clients/auth/auth-client";
import config from "@/lib/config/config";
import { usePublicConfig } from "@/lib/config/config.query";

export function PostHogProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();
  const { data: publicConfig, isLoading: isPublicConfigLoading } =
    usePublicConfig();
  const hasIdentifiedUserRef = useRef(false);
  const isPostHogInitializedRef = useRef(false);
  const lastIdentifiedUserIdRef = useRef<string | null>(null);
  const userId = session?.user?.id;
  const userEmail = session?.user?.email;
  const userName = session?.user?.name;

  useEffect(() => {
    const analytics = publicConfig?.analytics;

    if (
      !isPublicConfigLoading &&
      analytics?.enabled &&
      analytics.posthog.key &&
      !isPostHogInitializedRef.current
    ) {
      posthog.init(analytics.posthog.key, {
        ...config.posthog.config,
        api_host: analytics.posthog.host,
      });
      isPostHogInitializedRef.current = true;
    }
  }, [isPublicConfigLoading, publicConfig]);

  useEffect(() => {
    const analyticsEnabled = publicConfig?.analytics?.enabled;
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
  }, [isSessionPending, publicConfig, userEmail, userId, userName]);

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
