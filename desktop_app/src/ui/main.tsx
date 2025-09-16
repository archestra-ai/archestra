import React from 'react';
import ReactDOM from 'react-dom/client';

import sentryClient from '@ui/lib/sentry';
import websocketService from '@ui/lib/websocket';
import { useUserStore } from '@ui/stores/user-store';
import logCapture from '@ui/utils/logCapture';

import App from './App';

import './index.css';

// Initialize frontend log capture for bug reporting
// This will start capturing all console outputs
logCapture;

// Initialize Sentry early for error tracking
sentryClient.initialize();

// Fetch user data and set Sentry user context
useUserStore
  .getState()
  .fetchUser()
  .then(() => {
    const user = useUserStore.getState().user;
    if (user) {
      sentryClient.setUserContext(user);
    }
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
