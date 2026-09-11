import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";

/** @public — client adapter for Claude Code */
export { AppaClaudeCodeAdapter } from "./adapters/claude-code";
/** @public — client adapter for Codex */
export { AppaCodexAdapter } from "./adapters/codex";
/** @public — client adapter for OpenCode */
export { AppaOpenCodeAdapter } from "./adapters/opencode";
/** @public — foundational meta-plugin */
export { AppaPluginArchestra } from "./plugin";
export * from "./types";

let pluginInstance: AppaPluginArchestra | null = null;

/**
 * Initializes and returns the foundational appa-plugin-archestra meta-plugin
 * with default client adapters registered.
 */
export function getAppaPluginArchestra(): AppaPluginArchestra {
  if (!pluginInstance) {
    pluginInstance = new AppaPluginArchestra();
    pluginInstance.registerClientAdapter(new AppaClaudeCodeAdapter());
    pluginInstance.registerClientAdapter(new AppaCodexAdapter());
    pluginInstance.registerClientAdapter(new AppaOpenCodeAdapter());
  }
  return pluginInstance;
}
