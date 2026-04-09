import React, { useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { addMCPToRegistry, installMCP } from '../../actions/mcpActions';
import { MCPError } from '../types/mcp';
import './AddMCPToRegistry.css';

interface RootState {
  mcp: {
    error: MCPError | null;
    loading: boolean;
  };
}

const AddMCPToRegistry: React.FC = () => {
  const dispatch = useDispatch();
  const { error, loading } = useSelector((state: RootState) => state.mcp);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleAddMCP = useCallback(
    async (mcpId: string) => {
      setLocalError(null);

      try {
        await (dispatch as any)(
          addMCPToRegistry({ id: mcpId, name: mcpId, version: '1.0.0' })
        );
      } catch (err) {
        const error = err as MCPError;
        setLocalError(error.message);
      }
    },
    [dispatch]
  );

  const handleInstallMCP = useCallback(
    async (mcpId: string) => {
      setLocalError(null);

      try {
        await (dispatch as any)(installMCP(mcpId));
      } catch (err) {
        const error = err as MCPError;
        setLocalError(error.message);
      }
    },
    [dispatch]
  );

  const displayError = localError || error?.message;

  return (
    <div className="mcp-container">
      <h1>Add MCP to Registry</h1>

      <div className="button-group">
        <button
          onClick={() => handleAddMCP('google-workspace-mcp')}
          disabled={loading}
          aria-busy={loading}
          className="btn btn-primary"
        >
          {loading ? 'Processing...' : 'Add Google Workspace MCP'}
        </button>

        <button
          onClick={() => handleInstallMCP('google-workspace-mcp')}
          disabled={loading}
          aria-busy={loading}
          className="btn btn-secondary"
        >
          {loading ? 'Installing...' : 'Install Google Workspace MCP'}
        </button>
      </div>

      {displayError && (
        <div className="error-container" role="alert">
          <strong>Error:</strong> {displayError}
        </div>
      )}

      {loading && (
        <div className="loading-container" role="status" aria-live="polite">
          <span className="spinner"></span>
          Loading...
        </div>
      )}
    </div>
  );
};

export default AddMCPToRegistry;
```

```css