import * as Sentry from '@sentry/electron/renderer';
import React from 'react';
import ReactDOM from 'react-dom/client';

import websocketService from '@ui/lib/websocket';

import config from '../config';
import App from './App';

import './index.css';

const { tracesSampleRate, replaysSessionSampleRate, replaysOnErrorSampleRate } = config.sentry;

Sentry.init({
  /**
   * Adds request headers and IP for users, for more info visit:
   * https://docs.sentry.io/platforms/javascript/guides/electron/configuration/options/#sendDefaultPii
   */
  sendDefaultPii: true,
  integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],

  /**
   * https://docs.sentry.io/platforms/javascript/configuration/options/#traces-sample-rate
   */
  tracesSampleRate,

  /**
   * Capture Replay for configured % of all sessions,
   * plus for configured % of sessions with an error
   *
   * https://docs.sentry.io/platforms/javascript/session-replay/configuration/#general-integration-configuration
   */
  replaysSessionSampleRate,
  replaysOnErrorSampleRate,
});

/**
 * Open a single websocket connection to WebSocket server when the app is loaded
 */
websocketService.connect().catch(console.error);

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
