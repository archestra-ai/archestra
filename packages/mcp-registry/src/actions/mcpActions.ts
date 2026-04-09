import axios, { AxiosError } from 'axios';
import validateConfig from '../utils/configValidator';
import { validateMCPId, validateMCPData } from '../utils/mcpValidation';
import { retryWithBackoff } from '../utils/retryWithBackoff';
import { MCPData, MCPError } from '../types/mcp';

export const ADD_MCP_TO_REGISTRY = 'ADD_MCP_TO_REGISTRY';
export const INSTALL_MCP = 'INSTALL_MCP';
export const MCP_ERROR = 'MCP_ERROR';
export const SET_LOADING = 'SET_LOADING';

const parseError = (error: unknown): MCPError => {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<{ message?: string; code?: string }>;
    
    if (error.code === 'ECONNABORTED') {
      return {
        code: 'TIMEOUT',
        message: 'Configuration error while installing Google Workspace MCP: Request timeout',
        details: { original: error.message },
      };
    }

    if (error.code === 'ENOTFOUND') {
      return {
        code: 'CONFIG_ERROR',
        message: 'Configuration error while installing Google Workspace MCP: API server not reachable',
        details: { original: error.message },
      };
    }

    return {
      code: axiosError.response?.data?.code || 'UNKNOWN_ERROR',
      message:
        axiosError.response?.data?.message ||
        'Configuration error while installing Google Workspace MCP: Installation failed',
      details: { status: axiosError.response?.status },
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message:
      error instanceof Error
        ? error.message
        : 'Configuration error while installing Google Workspace MCP: Unknown error occurred',
  };
};

export const addMCPToRegistry = (mcpData: unknown) => async (dispatch: any) => {
  dispatch({ type: SET_LOADING, payload: true });

  try {
    const config = validateConfig();
    const validatedData = validateMCPData(mcpData);

    const response = await retryWithBackoff(
      () =>
        axios.post(`${config.apiUrl}/mcp/registry`, validatedData, {
          timeout: config.timeout,
        }),
      { maxAttempts: config.retryAttempts }
    );

    dispatch({
      type: ADD_MCP_TO_REGISTRY,
      payload: response.data,
    });

    dispatch({ type: SET_LOADING, payload: false });
    return response.data;
  } catch (error) {
    const parsedError = parseError(error);

    dispatch({
      type: MCP_ERROR,
      payload: parsedError,
    });

    dispatch({ type: SET_LOADING, payload: false });
    throw parsedError;
  }
};

export const installMCP = (mcpId: string) => async (dispatch: any) => {
  dispatch({ type: SET_LOADING, payload: true });

  try {
    const config = validateConfig();
    const validatedId = validateMCPId(mcpId);

    const response = await retryWithBackoff(
      () =>
        axios.post(`${config.apiUrl}/mcp/${validatedId}/install`, {}, {
          timeout: config.timeout,
        }),
      { maxAttempts: config.retryAttempts }
    );

    dispatch({
      type: INSTALL_MCP,
      payload: response.data,
    });

    dispatch({ type: SET_LOADING, payload: false });
    return response.data;
  } catch (error) {
    const parsedError = parseError(error);

    dispatch({
      type: MCP_ERROR,
      payload: parsedError,
    });

    dispatch({ type: SET_LOADING, payload: false });
    throw parsedError;
  }
};
```

```typescript