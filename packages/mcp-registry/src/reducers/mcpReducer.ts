import {
  ADD_MCP_TO_REGISTRY,
  INSTALL_MCP,
  MCP_ERROR,
  SET_LOADING,
} from '../actions/mcpActions';
import { MCPRegistryState, MCPError } from '../types/mcp';

const initialState: MCPRegistryState = {
  mcpRegistry: [],
  installedMCPs: [],
  error: null,
  loading: false,
};

interface Action {
  type: string;
  payload?: unknown;
}

export default function mcpReducer(
  state = initialState,
  action: Action
): MCPRegistryState {
  switch (action.type) {
    case SET_LOADING:
      return {
        ...state,
        loading: action.payload as boolean,
      };

    case ADD_MCP_TO_REGISTRY:
      return {
        ...state,
        mcpRegistry: [...state.mcpRegistry, action.payload as any],
        error: null,
        loading: false,
      };

    case INSTALL_MCP:
      return {
        ...state,
        installedMCPs: [...state.installedMCPs, action.payload as any],
        error: null,
        loading: false,
      };

    case MCP_ERROR:
      return {
        ...state,
        error: action.payload as MCPError,
        loading: false,
      };

    default:
      return state;
  }
}
```

```typescript