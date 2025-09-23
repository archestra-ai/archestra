const IS_DEV = import.meta.env.DEV;

const HOST = import.meta.env.VITE_HOST || 'localhost';

/**
 * website base URL defaults to production, can be overridden for local development
 */
const ARCHESTRA_WEBSITE_BASE_URL = import.meta.env.VITE_ARCHESTRA_WEBSITE_BASE_URL || 'https://www.archestra.ai';

/**
 * In development, use Vite's dev server port (5173) which proxies to the backend
 * In production, connect directly to the backend server port
 */
const HTTP_PORT = IS_DEV ? import.meta.env.VITE_PORT || '5173' : '54587';
const WEBSOCKET_PORT = IS_DEV ? import.meta.env.VITE_WEBSOCKET_PORT || '5173' : '54588';

const BASE_URL = `http://${HOST}:${HTTP_PORT}`;

export default {
  isDev: IS_DEV,
  archestra: {
    apiUrl: BASE_URL,
    mcpUrl: `${BASE_URL}/mcp`,
    mcpProxyUrl: `${BASE_URL}/mcp_proxy`,
    chatStreamBaseUrl: `${BASE_URL}/api/llm`,
    ollamaProxyUrl: `${BASE_URL}/llm/ollama`,
    websocketUrl: `ws://${HOST}:${WEBSOCKET_PORT}/ws`,
    websiteUrl: ARCHESTRA_WEBSITE_BASE_URL,
    catalogUrl: `${ARCHESTRA_WEBSITE_BASE_URL}/mcp-catalog/api`,
  },
  chat: {
    defaultTitle: 'New Agent',
    systemMemoriesMessageId: 'system-memories',
  },
  posthog: {
    apiKey: 'phc_FFZO7LacnsvX2exKFWehLDAVaXLBfoBaJypdOuYoTk7',
    host: 'https://eu.i.posthog.com',
  },
};
