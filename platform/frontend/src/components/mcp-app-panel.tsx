import React, { useState } from "react";

interface McpAppPanelProps {
  appUrl: string;
  serverName: string;
  onClose: () => void;
}

/**
 * McpAppPanel renders a third-party MCP App UI inside an iframe.
 * Supports MCP Apps such as n8n-mcp and excalidraw-mcp via MCP Gateway
 * and LLM Gateway.
 *
 * See: https://github.com/archestra-ai/archestra/issues/1301
 */
export function McpAppPanel({ appUrl, serverName, onClose }: McpAppPanelProps) {
  const [isLoading, setIsLoading] = useState(true);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        background: "rgba(0,0,0,0.7)",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          background: "#1a1a2e",
          borderBottom: "1px solid #333",
          color: "white",
        }}
      >
        <span style={{ fontWeight: 600 }}>
          {serverName} — MCP App
        </span>
        <button
          onClick={onClose}
          style={{
            background: "transparent",
            border: "none",
            color: "white",
            fontSize: 18,
            cursor: "pointer",
          }}
          aria-label="Close MCP App Panel"
        >
          ✕
        </button>
      </div>

      {/* iframe body */}
      <div style={{ flex: 1, position: "relative" }}>
        {isLoading && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#0f0f1a",
              color: "#888",
            }}
          >
            Loading {serverName}…
          </div>
        )}
        <iframe
          src={appUrl}
          title={`${serverName} MCP App`}
          style={{ width: "100%", height: "100%", border: "none" }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          onLoad={() => setIsLoading(false)}
        />
      </div>
    </div>
  );
}

export default McpAppPanel;
