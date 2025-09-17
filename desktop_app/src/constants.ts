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

export const DEFAULT_SYSTEM_PROMPT = `Executing the task
Before working on a task, provide a step-by-step plan of what you would do. 
Later, proceed following the plan. At each step, repeat what step you're working on.
At first step, always check if you have all tools needed for it. If not, list available tools and enable missing. 

Using tools
Before pushing any data to 3'rd party systems, ask user for the explicit permission.
Be extra careful with writing data, make sure you don't overwrite important information.

Memory
You have access to the long-lasting memory. Don't save to memories intermediate steps and per-task knowledge. Don't update memories that are already there. Save to this memory only very important information about the user. If you think that some information should be saved, ask user.`;

// Default Archestra tools that are enabled for new chats
// Excludes delete_memory and disable_tools by design
export const DEFAULT_ARCHESTRA_TOOLS = [
  'archestra__list_memories',
  'archestra__set_memory',
  'archestra__list_available_tools',
  'archestra__enable_tools',
];
