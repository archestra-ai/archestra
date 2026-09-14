import { registerLlmProxyPlugin } from "@/plugins/llm-proxy-plugin";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";

export {
  APPA_PLUGIN_BINDING,
  getAppaPluginRefusal,
  getAppaPluginResult,
} from "./plugin";

const appaPlugin = new AppaPluginArchestra([
  new AppaClaudeCodeAdapter(),
  new AppaCodexAdapter(),
  new AppaOpenCodeAdapter(),
]);
let registered = false;

export function registerAppaLlmProxyPlugin(): void {
  if (registered) return;
  registerLlmProxyPlugin(appaPlugin);
  registered = true;
}
