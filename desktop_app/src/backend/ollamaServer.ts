import { ChildProcess, spawn } from 'child_process';

import config from '@backend/config';
import { getBinaryExecPath } from '@backend/utils/binaries';
import log from '@backend/utils/logger';

class OllamaServer {
  private serverProcess: ChildProcess | null = null;
  private port = config.ollama.server.port;
  private isRunning: boolean = false;
  private binaryPath = getBinaryExecPath('ollama-v0.11.4');

  /**
   * Start the Ollama server
   */
  async startServer(): Promise<void> {
    if (this.isRunning) {
      log.info('Ollama server is already running');
      return;
    }

    try {
      log.info(`Starting Ollama server on port ${this.port}`);

      // Set up environment variables
      const env = {
        /**
         * Ollama needs the HOME environment variable to be set to the user's home directory
         * so that it can write to the user's .ollama directory
         */
        HOME: process.env.HOME,
        OLLAMA_HOST: `localhost:${this.port}`,
        OLLAMA_ORIGINS: 'http://localhost:54587',
        OLLAMA_DEBUG: '0',
      };

      // Spawn the Ollama process
      this.serverProcess = spawn(this.binaryPath, ['serve'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Handle stdout
      this.serverProcess.stdout?.on('data', (data) => {
        log.info(`[Ollama stdout]: ${data.toString()}`);
      });

      /**
       * Handle stderr (Ollama outputs normal logs to stderr, not just errors)
       *
       * Ollama uses stderr for normal logging output, not just errors
       * Check if it's actually an error by looking for error indicators
       */
      this.serverProcess.stderr?.on('data', (data) => {
        const message = data.toString();
        if (
          message.toLowerCase().includes('error') ||
          message.toLowerCase().includes('failed') ||
          message.toLowerCase().includes('fatal')
        ) {
          log.error(`[Ollama stderr]: ${message}`);
        } else {
          log.info(`[Ollama stdout]: ${message}`);
        }
      });

      // Handle process exit
      this.serverProcess.on('exit', (code, signal) => {
        log.info(`Ollama server exited with code ${code} and signal ${signal}`);
        this.isRunning = false;
        this.serverProcess = null;
      });

      // Handle errors
      this.serverProcess.on('error', (error) => {
        log.error('Failed to start Ollama server:', error);
        this.isRunning = false;
        this.serverProcess = null;
      });

      this.isRunning = true;

      log.info(`Ollama server started successfully on port ${this.port}`);
    } catch (error) {
      log.error('Failed to start Ollama server:', error);
      throw error;
    }
  }

  /**
   * Stop the Ollama server
   */
  async stopServer(): Promise<void> {
    if (!this.isRunning || !this.serverProcess) {
      log.info('Ollama server is not running');
      return;
    }

    log.info('Stopping Ollama server...');

    return new Promise((resolve) => {
      if (this.serverProcess) {
        this.serverProcess.once('exit', () => {
          this.isRunning = false;
          this.serverProcess = null;
          log.info('Ollama server stopped');
          resolve();
        });

        // Try graceful shutdown first
        this.serverProcess.kill('SIGTERM');

        // Force kill after 5 seconds if still running
        setTimeout(() => {
          if (this.serverProcess) {
            log.info('Force killing Ollama server');
            this.serverProcess.kill('SIGKILL');
          }
        }, 5000);
      } else {
        resolve();
      }
    });
  }
}

export default new OllamaServer();
