"use client";

import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useCallback, useEffect, useRef } from "react";
import { useSession } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { usePublicConfig } from "@/lib/config/config.query";

export function PostHogProviderWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: publicConfig, isLoading: isPublicConfigLoading } =
    usePublicConfig();
  const hasIdentifiedUserRef = useRef(false);
  const isPostHogInitializedRef = useRef(false);
  const lastRegisteredInstanceIdRef = useRef<string | null>(null);
  const lastIdentifiedUserIdRef = useRef<string | null>(null);
  const userId = session?.user?.id;
  const userEmail = session?.user?.email;
  const userName = session?.user?.name;

  const registerInstance = useCallback((instanceId: string) => {
    posthog.register({
      instance_id: instanceId,
    });
    posthog.group("instance", instanceId);
    lastRegisteredInstanceIdRef.current = instanceId;
  }, []);

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

    if (
      analytics?.enabled &&
      analytics.instanceId &&
      isPostHogInitializedRef.current &&
      analytics.instanceId !== lastRegisteredInstanceIdRef.current
    ) {
      registerInstance(analytics.instanceId);
    }
  }, [isPublicConfigLoading, publicConfig, registerInstance]);

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
      const instanceId = publicConfig?.analytics?.instanceId;
      posthog.reset();
      if (instanceId) {
        registerInstance(instanceId);
      }
      hasIdentifiedUserRef.current = false;
      lastIdentifiedUserIdRef.current = null;
    }
  }, [
    isSessionPending,
    publicConfig,
    registerInstance,
    userEmail,
    userId,
    userName,
  ]);

  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
}
