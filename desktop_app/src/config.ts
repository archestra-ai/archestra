export default {
  sentry: {
    dsn: 'https://7ad7390dc2610a248b8c00beaa3edbc7@o4509825927479296.ingest.de.sentry.io/4509826014445648',
    tracesSampleRate: 0.25,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  },
  vercelSdk: {
    maxToolCalls: 30,
  },
  build: {
    updateInterval: '1 hour',
    github: {
      owner: 'archestra-ai',
      repoName: 'archestra',
    },
    productName: 'Archestra',
    description: 'Enterprise MCP Platform for AI Agents',
    authors: 'Archestra.ai',
    appBundleId: 'com.archestra.ai',
  },
};
