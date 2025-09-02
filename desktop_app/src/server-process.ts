/**
 * Server Process Entry Point
 *
 * This file serves as a separate entry point for the Fastify server process.
 * It's built as a standalone JavaScript file by Vite and executed in a forked
 * Node.js process (not Electron renderer process).
 *
 * Why this exists:
 * 1. Electron's main process uses a different module system than our server code
 * 2. The server needs to run in a pure Node.js environment for native modules
 * 3. This separation allows hot-reloading of server code during development
 *
 * The forge.config.ts defines this as a build target, producing server-process.js
 * which main.ts spawns as a child process with ELECTRON_RUN_AS_NODE=1
 */
import ArchestraMcpClient from '@backend/archestraMcp';
import { runDatabaseMigrations } from '@backend/database';
import UserModel from '@backend/models/user';
import { OllamaClient, OllamaServer } from '@backend/ollama';
import McpServerSandboxManager from '@backend/sandbox';
import { startFastifyServer, stopFastifyServer } from '@backend/server';
import log from '@backend/utils/logger';
import WebSocketServer from '@backend/websocket';

const startup = async () => {
  await runDatabaseMigrations();
  await UserModel.ensureUserExists();

  // Start WebSocket and Fastify servers first so they're ready for MCP connections
  WebSocketServer.start();
  await startFastifyServer();

  // Connect to the Archestra MCP server after Fastify is running
  try {
    await ArchestraMcpClient.connect();
    log.info('Archestra MCP client connected successfully');
  } catch (error) {
    log.error('Failed to connect Archestra MCP client:', error);
    // Continue anyway - the app can work without Archestra tools
  }

  // Now start the sandbox manager which will connect MCP clients
  McpServerSandboxManager.onSandboxStartupSuccess = () => {
    log.info('Sandbox startup successful');
  };
  McpServerSandboxManager.onSandboxStartupError = (error) => {
    log.error('Sandbox startup error:', error);
  };
  McpServerSandboxManager.start();

  await OllamaServer.startServer();

  /**
   * Ensure that ollama models that're required for various app functionality are available,
   * downloading them if necessary
   */
  await OllamaClient.ensureModelsAvailable();
};

/**
 * Cleanup function to gracefully shut down all services
 */
const cleanup = async () => {
  log.info('Server process cleanup starting...');

  try {
    // Stop the Fastify server first to free the port
    log.info('Stopping Fastify server...');
    await stopFastifyServer();

    // Stop the WebSocket server
    log.info('Stopping WebSocket server...');
    WebSocketServer.stop();

    // Disconnect from Archestra MCP server
    log.info('Disconnecting Archestra MCP client...');
    await ArchestraMcpClient.disconnect();

    // Stop the sandbox and all MCP servers
    log.info('Turning off sandbox...');
    McpServerSandboxManager.turnOffSandbox();

    // Stop the Ollama server
    log.info('Stopping Ollama server...');
    await OllamaServer.stopServer();

    log.info('Server process cleanup completed');
  } catch (error) {
    log.error('Error during cleanup:', error);
  }
};

// Handle graceful shutdown on various signals
process.on('SIGTERM', async () => {
  log.info('Received SIGTERM signal');
  await cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('Received SIGINT signal (Ctrl+C)');
  await cleanup();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  log.error('Uncaught exception:', error);
  await cleanup();
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason, promise) => {
  log.error('Unhandled rejection at:', promise, 'reason:', reason);
  await cleanup();
  process.exit(1);
});

// Handle process exit
process.on('exit', (code) => {
  log.info(`Server process exiting with code: ${code}`);
});

startup();
