/**
 * Shared constants used by both backend and frontend
 */

export const FILE_SYSTEM_BASE_MOUNT_PATH = '/home/mcp';

// System models that are used internally and should not be shown in the user model selector
export const SYSTEM_MODELS = {
  GUARD: 'llama-guard3:1b',
  GENERAL: 'phi3:3.8b',
};

// Array of system model names for easy filtering
export const SYSTEM_MODEL_NAMES = [SYSTEM_MODELS.GUARD, SYSTEM_MODELS.GENERAL];

export const DEFAULT_SYSTEM_PROMPT = `Executing the task
Before working on a task, provide a step-by-step plan of what you would do.
Later, proceed following the plan. At each step, repeat what step you're working on.
Check if you have all needed tools. If not, list available tools and enable missing.
Don't stop until the task will be fully finished.
At first step, always check if you have all tools needed for it. If not, list available tools and enable missing.

Filesystem access
If you are considering using any Filesystem access tools, any paths that you are considering using should be relative to ${FILE_SYSTEM_BASE_MOUNT_PATH}. Example, if you want to use Desktop/file.txt, it would be ${FILE_SYSTEM_BASE_MOUNT_PATH}/Desktop/file.txt.

Using tools
Before pushing any data to 3rd party systems, ask user for the explicit permission.
Be extra careful with writing data, make sure you don't overwrite important information.

Memory
You have access to the long-lasting memory. Don't save to memories intermediate steps and per-task knowledge. Don't update memories that are already there. Save to this memory only very important information about the user. If you think that some information should be saved, ask user.`;

/**
 * Archestra MCP server ID
 */
export const ARCHESTRA_MCP_SERVER_ID = 'archestra';

/**
 * We use a double underscore to separate the MCP server ID from the tool name.
 *
 * this is for LLM compatability..
 */
export const TOOL_ID_SERVER_TOOL_NAME_SEPARATOR = '__';

export const constructToolId = (serverId: string, toolName: string) =>
  `${serverId}${TOOL_ID_SERVER_TOOL_NAME_SEPARATOR}${toolName}`;

/**
 * Some MCP servers contain multiple double underscores, like this:
 *  servers__src__filesystem__list_allowed_directorie
 *
 * So we need to split on the last double underscore
 */
export const deconstructToolId = (toolId: string) => {
  const separatorIndex = toolId.lastIndexOf(TOOL_ID_SERVER_TOOL_NAME_SEPARATOR);
  const toolName =
    separatorIndex !== -1 ? toolId.substring(separatorIndex + TOOL_ID_SERVER_TOOL_NAME_SEPARATOR.length) : toolId;

  return {
    serverName: toolId.substring(0, separatorIndex),
    toolName,
  };
};

/**
 * Archestra MCP tool IDs (without the server ID prefix)
 */
export const ARCHESTRA_MCP_TOOLS = {
  LIST_MEMORIES: 'list_memories',
  SET_MEMORY: 'set_memory',
  DELETE_MEMORY: 'delete_memory',
  LIST_AVAILABLE_TOOLS: 'list_available_tools',
  ENABLE_TOOLS: 'enable_tools',
  DISABLE_TOOLS: 'disable_tools',
};

/**
 * Fully qualified Archestra MCP tool IDs (with the server ID prefix)
 */
export const FULLY_QUALIFED_ARCHESTRA_MCP_TOOL_IDS = {
  LIST_MEMORIES: constructToolId(ARCHESTRA_MCP_SERVER_ID, ARCHESTRA_MCP_TOOLS.LIST_MEMORIES),
  SET_MEMORY: constructToolId(ARCHESTRA_MCP_SERVER_ID, ARCHESTRA_MCP_TOOLS.SET_MEMORY),
  DELETE_MEMORY: constructToolId(ARCHESTRA_MCP_SERVER_ID, ARCHESTRA_MCP_TOOLS.DELETE_MEMORY),
  LIST_AVAILABLE_TOOLS: constructToolId(ARCHESTRA_MCP_SERVER_ID, ARCHESTRA_MCP_TOOLS.LIST_AVAILABLE_TOOLS),
  ENABLE_TOOLS: constructToolId(ARCHESTRA_MCP_SERVER_ID, ARCHESTRA_MCP_TOOLS.ENABLE_TOOLS),
  DISABLE_TOOLS: constructToolId(ARCHESTRA_MCP_SERVER_ID, ARCHESTRA_MCP_TOOLS.DISABLE_TOOLS),
};

/**
 * Default Archestra tools that are enabled for new chats
 * Excludes delete_memory and disable_tools by design
 */
export const DEFAULT_ARCHESTRA_TOOLS = [
  FULLY_QUALIFED_ARCHESTRA_MCP_TOOL_IDS.LIST_MEMORIES,
  FULLY_QUALIFED_ARCHESTRA_MCP_TOOL_IDS.SET_MEMORY,
  FULLY_QUALIFED_ARCHESTRA_MCP_TOOL_IDS.LIST_AVAILABLE_TOOLS,
  FULLY_QUALIFED_ARCHESTRA_MCP_TOOL_IDS.ENABLE_TOOLS,
];
