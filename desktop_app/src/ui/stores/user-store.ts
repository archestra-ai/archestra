import { create } from 'zustand';

import { type User, getUser, updateUser } from '@ui/lib/clients/archestra/api/gen';
import posthogClient from '@ui/lib/posthog';
import sentryClient from '@ui/lib/sentry';

interface UserStore {
  user: User | null;
  loading: boolean;

  fetchUser: () => Promise<void>;
  markOnboardingCompleted: () => Promise<void>;
  toggleTelemetryCollectionStatus: (collectTelemetryData: boolean) => Promise<void>;
  toggleAnalyticsCollectionStatus: (collectAnalyticsData: boolean) => Promise<void>;
}

export const useUserStore = create<UserStore>((set, get) => ({
  user: null,
  loading: false,

  fetchUser: async () => {
    set({ loading: true });
    try {
      const { data } = await getUser();
      set({ user: data });
    } finally {
      set({ loading: false });
    }
  },

  markOnboardingCompleted: async () => {
    const { data } = await updateUser({ body: { hasCompletedOnboarding: true } });
    set({ user: data });

    // Track onboarding completion in PostHog
    posthogClient.capture('onboarding_completed');
  },

  toggleTelemetryCollectionStatus: async (collectTelemetryData: boolean) => {
    const { user } = get();
    if (!user) return;

    const { data } = await updateUser({ body: { collectTelemetryData } });
    set({ user: data });

    // Update Sentry client telemetry status
    sentryClient.updateTelemetryStatus(collectTelemetryData, data);
  },

  toggleAnalyticsCollectionStatus: async (collectAnalyticsData: boolean) => {
    const { user } = get();
    if (!user) return;

    const { data } = await updateUser({ body: { collectAnalyticsData } });
    set({ user: data });

    // Update PostHog analytics status
    posthogClient.updateAnalyticsStatus(collectAnalyticsData, data);
  },
}));
