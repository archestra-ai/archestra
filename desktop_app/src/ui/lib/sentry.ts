import * as Sentry from '@sentry/electron/renderer';

import { type User } from '@ui/lib/clients/archestra/api/gen';

import config from '../../config';

const { tracesSampleRate, replaysSessionSampleRate, replaysOnErrorSampleRate } = config.sentry;

class SentryClient {
  private initialized = false;

  /**
   * Initialize Sentry early for error tracking
   */
  initialize() {
    if (this.initialized) {
      console.log('Sentry already initialized');
      return;
    }

    Sentry.init({
      dsn: config.sentry.dsn,
      sendDefaultPii: true,
      integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
      tracesSampleRate,
      replaysSessionSampleRate,
      replaysOnErrorSampleRate,
    });

    this.initialized = true;
    console.log('Sentry initialized for renderer process');
  }

  /**
   * Set user context for Sentry
   */
  setUserContext(user: User) {
    if (!this.initialized) {
      console.warn('Sentry not initialized, cannot set user context');
      return;
    }

    if (user.collectTelemetryData && user.uniqueId) {
      Sentry.setUser({
        id: user.uniqueId,
      });
      console.log('Sentry user context set');
    } else {
      this.clearUserContext();
    }
  }

  /**
   * Clear user context from Sentry
   */
  clearUserContext() {
    if (!this.initialized) {
      return;
    }

    Sentry.setUser(null);
    console.log('Sentry user context cleared');
  }

  /**
   * Update telemetry collection status
   */
  updateTelemetryStatus(collectTelemetryData: boolean, user: User | null = null) {
    if (!this.initialized) {
      console.warn('Sentry not initialized');
      return;
    }

    if (collectTelemetryData) {
      // Re-enable Sentry and set user context
      Sentry.getCurrentScope().setClient(Sentry.getClient());
      if (user) {
        this.setUserContext(user);
      }
      console.log('Sentry telemetry enabled');
    } else {
      // Clear user context and disable Sentry
      this.clearUserContext();
      // Disable Sentry by removing the client
      const client = Sentry.getClient();
      if (client) {
        client.close();
      }
      console.log('Sentry telemetry disabled');
    }
  }
}

export default new SentryClient();
