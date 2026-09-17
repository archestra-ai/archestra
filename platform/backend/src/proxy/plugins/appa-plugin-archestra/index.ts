import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";

export function createAppaLlmProxyPlugin(): AppaPluginArchestra {
  return new AppaPluginArchestra([
    // Prefer externally declared client protocols; Chat's trusted loopback marker
    // is intentionally last so incidental SDK headers keep their native syntax.
    new AppaClaudeCodeAdapter(),
    new AppaCodexAdapter(),
    new AppaOpenCodeAdapter(),
    new AppaChatAdapter(),
  ]);
}
