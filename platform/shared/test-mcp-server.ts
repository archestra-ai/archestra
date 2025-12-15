// MCP server script using the SDK - installed at runtime
const testMcpServerScript = `
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const server = new McpServer({ name: 'dev-test-server', version: '1.0.0' });

server.tool('print_archestra_test', 'Prints the ARCHESTRA_TEST environment variable value', {}, async () => {
  const value = process.env.ARCHESTRA_TEST || '(not set)';
  return { content: [{ type: 'text', text: 'ARCHESTRA_TEST = ' + value }] };
});

const transport = new StdioServerTransport();
server.connect(transport);
`.trim();
export const testMcpServerCommand = `npm install --silent @modelcontextprotocol/sdk && node -e '${testMcpServerScript.replace(/'/g, "'\"'\"'")}'`;
