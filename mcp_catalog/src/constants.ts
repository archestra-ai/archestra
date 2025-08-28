const DEBUG = !['production', 'prod'].includes(process.env.NODE_ENV?.toLowerCase() || '');

const PORT = parseInt(process.env.PORT || '3000', 10);

export default {
  debug: DEBUG,
  baseUrl: process.env.API_BASE_URL || `http://localhost:${PORT}`,
  logLevel: process.env.LOG_LEVEL || 'info',
  server: {
    port: PORT,
    host: process.env.HOST || '0.0.0.0',
  },
};
