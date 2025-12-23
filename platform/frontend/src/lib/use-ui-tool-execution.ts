import { useState, useCallback } from 'react';
import { McpToolResponse } from '../mcp-ui.types';

export function useUiToolExecution() {
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const executeWithUi = useCallback(async (executionFn: () => Promise<McpToolResponse>) => {
    setIsRendering(true);
    setError(null);
    try {
      const result = await executionFn();
      setIsRendering(false);
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error rendering UI component');
      setIsRendering(false);
      throw err;
    }
  }, []);

  return { executeWithUi, isRendering, error };
}