const IS_DEV = import.meta.env.DEV;

const HOST = import.meta.env.VITE_HOST || 'localhost';

// In development, use Vite's dev server port (5173) which proxies to the backend
// In production, connect directly to the backend server port
const HTTP_PORT = IS_DEV ? import.meta.env.VITE_PORT || '5173' : '54587';
const WEBSOCKET_PORT = IS_DEV ? import.meta.env.VITE_WEBSOCKET_PORT || '5173' : '54588';

const BASE_URL = `${HOST}:${HTTP_PORT}`;
const BASE_URL_WITH_PROTOCOL = `http://${BASE_URL}`;

// Catalog URL - defaults to production, can be overridden for local development
const CATALOG_URL = import.meta.env.VITE_ARCHESTRA_CATALOG_URL || 'https://www.archestra.ai/mcp-catalog/api';

export default {
  isDev: IS_DEV,
  archestra: {
    apiUrl: BASE_URL_WITH_PROTOCOL,
    /**
     * NOTE: for mcpUrl and mcpProxyUrl, we NEED to have the protocol specified, otherwise you'll see this
     * (on the browser side of things):
     *
     * Fetch API cannot load localhost:5173/mcp. URL scheme "localhost" is not supported.
     *
     */
    mcpUrl: `${BASE_URL_WITH_PROTOCOL}/mcp`,
    mcpProxyUrl: `${BASE_URL_WITH_PROTOCOL}/mcp_proxy`,
    chatStreamBaseUrl: `${BASE_URL_WITH_PROTOCOL}/api/llm`,
    ollamaProxyUrl: `${BASE_URL}/llm/ollama`,
    websocketUrl: `ws://${HOST}:${WEBSOCKET_PORT}/ws`,
    catalogUrl: CATALOG_URL,
  },
  chat: {
    defaultTitle: 'New Agent',
    systemMemoriesMessageId: 'system-memories',
  },
};
