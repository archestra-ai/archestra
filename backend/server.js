const express = require('express');
const app = express();

app.get('/api/mcp-apps', (req, res) => {
  const mcpApps = [
    { id: 1, name: 'App 1' },
    { id: 2, name: 'App 2' },
    { id: 3, name: 'App 3' },
  ];
  res.json(mcpApps);
});

app.post('/api/mcp-gateway', (req, res) => {
  res.json({ status: 'success', message: 'Data processed by MCP Gateway' });
});

app.post('/api/llm-gateway', (req, res) => {
  res.json({ status: 'success', message: 'Data processed by LLM Gateway' });
});

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});