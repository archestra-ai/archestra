import { z } from 'zod';

import { SelectUserSchema } from '@backend/database/schema/user';
import log from '@backend/utils/logger';

import config from '../../config';

type User = z.infer<typeof SelectUserSchema>;

// Only import Sentry when not running as Node (e.g., during codegen)
let Sentry: typeof import('@sentry/electron/main') | null = null;
if (!process.env.ELECTRON_RUN_AS_NODE) {
  Sentry = require('@sentry/electron/main');
}

class SentryClient {
  private initialized = false;

  /**
   * Initialize Sentry early for error tracking
   */
  initialize() {
    if (!Sentry) {
      log.info('Sentry not available (running in Node mode)');
      return;
    }

    if (this.initialized) {
      log.info('Sentry already initialized');
      return;
    }

    Sentry.init({
      dsn: config.sentry.dsn,
    });

    this.initialized = true;
    log.info('Sentry initialized for main process');
  }

  /**
   * Set user context for Sentry
   */
  setUserContext(user: User) {
    if (!Sentry) {
      return;
    }

    if (!this.initialized) {
      log.warn('Sentry not initialized, cannot set user context');
      return;
    }

    if (user.collectTelemetryData && user.uniqueId) {
      Sentry.setUser({
        id: `user_${user.uniqueId}`,
      });
      log.info('Sentry user context set');
    } else {
      this.clearUserContext();
    }
  }

  /**
   * Clear user context from Sentry
   */
  clearUserContext() {
    if (!Sentry || !this.initialized) {
      return;
    }

    Sentry.setUser(null);
    log.info('Sentry user context cleared');
  }

  /**
   * Update telemetry collection status
   */
  updateTelemetryStatus(collectTelemetryData: boolean, user: User | null = null) {
    if (!Sentry) {
      return;
    }

    if (!this.initialized) {
      log.warn('Sentry not initialized');
      return;
    }

    if (collectTelemetryData) {
      // Re-enable Sentry and set user context
      Sentry.getCurrentScope().setClient(Sentry.getClient());
      if (user) {
        this.setUserContext(user);
      }
      log.info('Sentry telemetry enabled');
    } else {
      // Clear user context and disable Sentry
      this.clearUserContext();
      Sentry.getCurrentScope().setClient(undefined);
      log.info('Sentry telemetry disabled');
    }
  }
}

export default new SentryClient();
