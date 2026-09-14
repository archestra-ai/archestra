import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";

export { APPA_PLUGIN_TRUSTED_CONTEXT } from "./plugin";

const appaPlugin = new AppaPluginArchestra([
  new AppaClaudeCodeAdapter(),
  new AppaCodexAdapter(),
  new AppaOpenCodeAdapter(),
  new AppaChatAdapter(),
]);
let registered = false;

export function registerAppaLlmProxyPlugin(): void {
  if (registered) return;
  registerLlmProxyPlugin(appaPlugin);
  registered = true;
}
