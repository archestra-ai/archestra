const HOST = import.meta.env.VITE_HOST || 'localhost';

// NOTE: 5173 is the default port for Vite's dev server
const PORT = import.meta.env.VITE_PORT || '5173';

const BASE_URL = `${HOST}:${PORT}`;
const BASE_URL_WITH_PROTOCOL = `http://${BASE_URL}`;

// Catalog URL - defaults to production, can be overridden for local development
const CATALOG_URL = import.meta.env.VITE_ARCHESTRA_CATALOG_URL || 'https://www.archestra.ai/mcp-catalog/api';

export default {
  debug: !['production', 'prod'].includes(process.env.NODE_ENV?.toLowerCase() || ''),
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
    websocketUrl: `ws://${BASE_URL}/ws`,
    catalogUrl: CATALOG_URL,
  },
  chat: {
    defaultTitle: 'New Chat',
  },
};
