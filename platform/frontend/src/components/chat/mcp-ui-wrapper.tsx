import React, { useEffect, useRef } from 'react';

interface MCPUIWrapperProps {
  url: string;
  metadata: any;
  onAction: (action: string, payload: any) => void;
}

export const MCPUIWrapper: React.FC<MCPUIWrapperProps> = ({ url, metadata, onAction }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== new URL(url).origin) return;

      const { type, payload } = event.data;
      if (type === 'mcpui:action') {
        onAction(payload.action, payload.data);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [url, onAction]);

  useEffect(() => {
    if (iframeRef.current && iframeRef.current.contentWindow) {
      iframeRef.current.contentWindow.postMessage({
        type: 'mcpui:init',
        payload: { metadata }
      }, new URL(url).origin);
    }
  }, [metadata, url]);

  return (
    <iframe
      ref={iframeRef}
      src={url}
      style={{ width: '100%', height: '400px', border: 'none', borderRadius: '8px' }}
      title="MCP Interactive UI"
    />
  );
};
