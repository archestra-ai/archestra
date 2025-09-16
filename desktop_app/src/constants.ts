/**
 * Shared constants used by both backend and frontend
 */

// System models that are used internally and should not be shown in the user model selector
export const SYSTEM_MODELS = {
  GUARD: 'llama-guard3:1b',
  GENERAL: 'phi3:3.8b',
};

// Array of system model names for easy filtering
export const SYSTEM_MODEL_NAMES = [SYSTEM_MODELS.GUARD, SYSTEM_MODELS.GENERAL];

// Default Archestra tools that are enabled for new chats
// Excludes delete_memory and disable_tools by design
export const DEFAULT_ARCHESTRA_TOOLS = [
  'archestra__list_memories',
  'archestra__get_memory',
  'archestra__set_memory',
  'archestra__list_available_tools',
  'archestra__enable_tools',
];
