const IS_DEV = import.meta.env.DEV;

const HOST = import.meta.env.VITE_HOST || 'localhost';

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
    /**
     * catalog URL defaults to production, can be overridden for local development
     */
    catalogUrl: import.meta.env.VITE_ARCHESTRA_CATALOG_URL || 'https://www.archestra.ai/mcp-catalog/api',
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
