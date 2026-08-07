// biome-ignore-all lint/suspicious/noExplicitAny: test
import { AgentModel } from "@/models";
import { expect, test } from "@/test";
import McpToolCallModel from "./mcp-tool-call";

const SECRET_VALUE = "sk-arg-PLAINTEXT-must-not-escape";

async function makeAgentForToolCall() {
  return AgentModel.create({
    name: `agent-${crypto.randomUUID().slice(0, 8)}`,
    scope: "org",
    teams: [],
    knowledgeBaseIds: [],
  });
}

/** Arguments as `archestra__edit_mcp_config` receives them. */
function editConfigArgs() {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    environment: [
      {
        key: "NETBOX_TOKEN",
        type: "secret",
        value: SECRET_VALUE,
        promptOnInstallation: false,
      },
    ],
  };
}

test("a secret in tool-call arguments is not persisted in the log", async () => {
  const agent = await makeAgentForToolCall();

  const created = await McpToolCallModel.create({
    agentId: agent.id,
    mcpServerName: "archestra",
    method: "tools/call",
    toolCall: {
      id: "call-1",
      name: "archestra__edit_mcp_config",
      arguments: editConfigArgs(),
    },
    toolResult: { isError: false, content: "ok" },
  });

  const stored = await McpToolCallModel.findById(created.id);
  expect(JSON.stringify(stored?.toolCall)).not.toContain(SECRET_VALUE);
  // The surrounding arguments stay intact so the log is still diagnosable.
  expect((stored?.toolCall?.arguments as any)?.environment?.[0].key).toBe(
    "NETBOX_TOKEN",
  );
});

/**
 * `create` hands its input to the in-place encrypt helper behind a shallow
 * spread, so callers keep their plaintext copy to build the JSON-RPC response.
 * Redaction has to respect the same contract — mutating the caller's nested
 * `toolCall` would corrupt the response actually returned to the client.
 */
test("create does not mutate the caller's toolCall object", async () => {
  const agent = await makeAgentForToolCall();

  const toolCall = {
    id: "call-2",
    name: "archestra__edit_mcp_config",
    arguments: editConfigArgs(),
  };

  await McpToolCallModel.create({
    agentId: agent.id,
    mcpServerName: "archestra",
    method: "tools/call",
    toolCall,
    toolResult: { isError: false, content: "ok" },
  });

  expect((toolCall.arguments as any).environment[0].value).toBe(SECRET_VALUE);
});
