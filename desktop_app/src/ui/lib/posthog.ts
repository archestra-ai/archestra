import posthog from 'posthog-js';

import config from '@ui/config';
import { useUserStore } from '@ui/stores/user-store';

const { apiKey, ...posthogConfig } = config.posthog;

class PostHogClient {
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const appInfo = await window.electronAPI.getAppInfo();

    if (!appInfo.isPackaged) {
      console.log('PostHog analytics disabled for dev (non-packaged) builds of the app');
      return;
    }

    const user = useUserStore.getState().user;

    if (!user?.collectAnalyticsData) {
      console.log('PostHog analytics disabled by user preference');
      return;
    }

    posthog.init(apiKey, posthogConfig);

    if (user.uniqueId) {
      posthog.identify(user.uniqueId);
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
