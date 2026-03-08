import React, { useState, useEffect } from 'react';

const MCPAppIntegration = () => {
  const [mcpData, setMcpData] = useState(null);

  useEffect(() => {
    const fetchMCPData = async () => {
      try {
        const response = await fetch('/api/mcp-apps');
        const data = await response.json();
        setMcpData(data);
      } catch (error) {
        console.error('Error fetching MCP data:', error);
      }
    };

    fetchMCPData();
  }, []);

  if (!mcpData) {
    return <div>Loading MCP Apps...</div>;
  }

  return (
    <div className="mcp-apps">
      <h3>MCP Apps</h3>
      <ul>
        {mcpData.map((app) => (
          <li key={app.id}>{app.name}</li>
        ))}
      </ul>
    </div>
  );
};

export default MCPAppIntegration;