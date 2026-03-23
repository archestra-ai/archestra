import React, { useEffect, useRef } from 'react';

interface MCPUIWrapperProps {
  url: string;
  onAction?: (action: any) => void;
}

export const MCPUIWrapper: React.FC<MCPUIWrapperProps> = ({ url, onAction }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== new URL(url).origin) return;
      if (onAction) onAction(event.data);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [url, onAction]);

  return (
    <iframe
      ref={iframeRef}
      src={url}
      style={{ width: '100%', height: '500px', border: 'none', borderRadius: '8px' }}
      sandbox="allow-scripts allow-same-origin allow-forms"
    />
  );
};
