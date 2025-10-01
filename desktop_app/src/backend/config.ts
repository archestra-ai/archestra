import { app } from 'electron';
import * as os from 'os';

import { SYSTEM_MODELS } from '@constants';

/**
 * TODO: update this to use import.meta.env.VITE_ARCHESTRA_WEBSITE_BASE_URL
 * aka the same environment variable that the frontend consumes...
 */
const ARCHESTRA_WEBSITE_BASE_URL = process.env.ARCHESTRA_WEBSITE_BASE_URL || 'https://www.archestra.ai';

const OLLAMA_SERVER_PORT = parseInt(process.env.ARCHESTRA_OLLAMA_SERVER_PORT || '54589', 10);
const OLLAMA_GUARD_MODEL = SYSTEM_MODELS.GUARD;
const OLLAMA_GENERAL_MODEL = SYSTEM_MODELS.GENERAL;

// Determine recommended Qwen3 model based on system RAM
const getRecommendedQwenModel = () => {
  const totalMemoryGB = Math.floor(os.totalmem() / (1024 * 1024 * 1024));

  if (totalMemoryGB >= 32) {
    return { model: 'qwen3:14b', reason: 'Recommended model for chat (32GB+ RAM, 14B parameters)' };
  } else if (totalMemoryGB >= 16) {
    return { model: 'qwen3:8b', reason: 'Recommended model for chat (16GB+ RAM, 8B parameters)' };
  } else {
    return { model: 'qwen3:1.7b', reason: 'Recommended model for chat (8GB+ RAM, 1.7B parameters)' };
  }
};

const RECOMMENDED_QWEN_MODEL = getRecommendedQwenModel();

/**
 * NOTE: in the context of codegen, app is not available (undefined), so we default to false
 * (also the reason why we use the ?. operator)
 */
const DEBUG = !app?.isPackaged;

export default {
  debug: DEBUG,
  logLevel: process.env.LOG_LEVEL || (DEBUG ? 'debug' : 'info'),
  archestra: {
    websiteUrl: ARCHESTRA_WEBSITE_BASE_URL,
    cloudLlmProxyAuthUrl: `${ARCHESTRA_WEBSITE_BASE_URL}/signin?callbackURL=${encodeURIComponent('archestra-ai://auth-success')}`,
  },
  server: {
    http: {
      port: parseInt(process.env.ARCHESTRA_API_SERVER_PORT || '54587', 10),
      host: 'localhost',
    },
    websocket: {
      port: parseInt(process.env.ARCHESTRA_WEBSOCKET_SERVER_PORT || '54588', 10),
    },
  },
  oauthProxy: {
    url: process.env.OAUTH_PROXY_URL || 'https://oauth.dev.archestra.ai',
  },
  ollama: {
    server: {
      host: `http://localhost:${OLLAMA_SERVER_PORT}`,
      port: OLLAMA_SERVER_PORT,
    },
    guardModel: OLLAMA_GUARD_MODEL,
    generalModel: OLLAMA_GENERAL_MODEL,
    recommendedModel: RECOMMENDED_QWEN_MODEL.model,
    requiredModels: [
      {
        model: OLLAMA_GUARD_MODEL,
        reason: 'Guard model for safety checks',
      },
      {
        model: OLLAMA_GENERAL_MODEL,
        reason: 'General tasks (tools analysis, chat summarization)',
      },
      RECOMMENDED_QWEN_MODEL,
    ],
  },
  sandbox: {
    baseDockerImage:
      process.env.MCP_BASE_DOCKER_IMAGE ||
      'europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:0.0.3',
    podman: {
      baseUrl: 'http://d/v5.0.0',
    },
  },
  logging: {
    mcpServerLogMaxSize: process.env.MCP_SERVER_LOG_MAX_SIZE || '5M', // Size before rotation (e.g., '5M', '100K', '1G')
    mcpServerLogMaxFiles: parseInt(process.env.MCP_SERVER_LOG_MAX_FILES || '2', 10), // Number of rotated files to keep
  },
};
