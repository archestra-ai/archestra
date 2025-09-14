import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/settings/mcp-servers')({
  beforeLoad: () => {
    // Redirect to the Connectors page since MCP Servers is now merged there
    throw redirect({
      to: '/connectors',
    });
  },
});
