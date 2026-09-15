import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";

/** Creates the configured APPA extension at process startup. */
export function createAppaLlmProxyPlugin(): AppaPluginArchestra {
  const plugin = new AppaPluginArchestra();
  plugin.registerClientAdapter(new AppaClaudeCodeAdapter());
  plugin.registerClientAdapter(new AppaCodexAdapter());
  plugin.registerClientAdapter(new AppaOpenCodeAdapter());
  plugin.registerClientAdapter(new AppaChatAdapter());
  return plugin;
}
