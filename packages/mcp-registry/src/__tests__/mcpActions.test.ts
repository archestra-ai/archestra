import configureMockStore from 'redux-mock-store';
import thunk from 'redux-thunk';
import axios from 'axios';
import {
  addMCPToRegistry,
  installMCP,
  ADD_MCP_TO_REGISTRY,
  INSTALL_MCP,
  MCP_ERROR,
  SET_LOADING,
} from '../actions/mcpActions';

jest.mock('