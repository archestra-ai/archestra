import posthog from 'posthog-js';

import { useUserStore } from '@ui/stores/user-store';

import config from '../../config';

class PostHogClient {
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;

    const user = useUserStore.getState().user;

    if (!user?.collectAnalyticsData) {
      console.log('PostHog analytics disabled by user preference');
      return;
    }

    posthog.init(config.posthog.apiKey, {
      api_host: config.posthog.apiHost,
      capture_pageview: false,
      capture_pageleave: false,
      persistence: 'localStorage+cookie',
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '[data-sensitive]',
        maskInputOptions: {
          password: true,
          email: true,
          tel: true,
        },
      },
    });

    if (user.id) {
      posthog.identify(`user_${user.id}`);
    }

    this.initialized = true;
    console.log('PostHog frontend initialized with session replay');
  }

  capture(event: string, properties?: Record<string, any>): void {
    if (!this.initialized) return;

    try {
      posthog.capture(event, properties);
    } catch (error) {
      console.error('Failed to capture PostHog event:', error);
    }
  }

  shutdown(): void {
    if (this.initialized) {
      posthog.opt_out_capturing();
      this.initialized = false;
    }
  }

  updateOptInStatus(collectAnalyticsData: boolean): void {
    if (collectAnalyticsData && !this.initialized) {
      this.initialize();
    } else if (!collectAnalyticsData && this.initialized) {
      this.shutdown();
    }
  }
}

export default new PostHogClient();
