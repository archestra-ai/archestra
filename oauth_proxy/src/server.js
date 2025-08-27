import { config, validateConfig } from './config/index.js';
import { buildApp } from './app.js';

async function start() {
  // Validate configuration
  validateConfig();

  // Build the Fastify app
  const app = await buildApp();

  try {
    // Start the server
    await app.listen({
      port: config.server.port,
      host: config.server.host,
    });
    
    const baseUrl = `http://localhost:${config.server.port}`;
    
    console.log('\n🚀 OAuth Proxy Server is running');
    console.log(`📍 ${baseUrl}`);
    console.log(`📍 Health check: ${baseUrl}/health`);
    console.log(`📍 API docs: ${baseUrl}/`);
    
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\nSIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Start the server
start();