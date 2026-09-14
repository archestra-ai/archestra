import { registerLlmProxyPlugin } from "@/plugins/llm-proxy-plugin";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";

export { AppaClaudeCodeAdapter } from "./adapters/claude-code";
export { AppaCodexAdapter } from "./adapters/codex";
export { AppaOpenCodeAdapter } from "./adapters/opencode";
export {
  APPA_PLUGIN_BINDING,
  AppaPluginArchestra,
  getAppaPluginRefusal,
  getAppaPluginResult,
} from "./plugin";
export type { AppaClientAdapter } from "./types";

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
