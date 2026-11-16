// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { HttpResponse, http } from "msw";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import { awsIamMcpSigner } from "@/services/aws-iam/aws-iam-mcp-signer";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { agentOwner } from "@/types";
import mcpClient from "./mcp-client";

const SERVER_URL = "https://gateway.example.com/mcp";
const ROLE_ARN = "arn:aws:iam::123456789012:role/archestra-agents";

/** The access key each tool call was signed with, by the call's argument. */
let signedCalls: { caller: unknown; accessKey: string | undefined }[];
/** The access key each tools/list was signed with. */
let listedBy: (string | undefined)[];

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
useMswServer(
  // Each role session gets an access key naming the session it belongs to.
  http.post("https://sts.us-east-1.amazonaws.com/", async ({ request }) => {
    const form = new URLSearchParams(await request.text());
    const session = `${form.get("RoleArn")?.split("/").pop()}-${form.get("RoleSessionName")}`;
    const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return new HttpResponse(
      `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>key-${session}</AccessKeyId><SecretAccessKey>secret</SecretAccessKey><SessionToken>token-${session}</SessionToken><Expiration>${expiration}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
      { headers: { "content-type": "text/xml" } },
    );
  }),
  http.get(SERVER_URL, () => new HttpResponse(null, { status: 405 })),
  http.post(SERVER_URL, async ({ request }) => {
    const message = (await request.json()) as {
      id?: number;
      method: string;
      params?: { arguments?: { caller?: unknown } };
    };
    if (message.id === undefined) {
      return new HttpResponse(null, { status: 202 });
    }
    if (message.method === "initialize") {
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "gateway", version: "1.0.0" },
        },
      });
    }
    if (message.method === "tools/list") {
      listedBy.push(
        request.headers
          .get("authorization")
          ?.match(/Credential=([^/]+)\//)?.[1],
      );
    }
    if (message.method !== "tools/call") {
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [] },
      });
    }
    signedCalls.push({
      caller: message.params?.arguments?.caller,
      accessKey: request.headers
        .get("authorization")
        ?.match(/Credential=([^/]+)\//)?.[1],
    });
    return HttpResponse.json({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: "ok" }] },
    });
  }),
);

describe("tool calls to an AWS IAM MCP server", () => {
  beforeEach(() => {
    signedCalls = [];
    listedBy = [];
    awsIamMcpSigner.clearCache();
  });

  afterEach(async () => {
    await mcpClient.disconnectAll();
  });

  test("each agent's calls are signed with its own role session", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    const { tool, server } = await installAwsServer(user.id);
    const agents = await Promise.all(
      ["first", "second"].map(async (name) => {
        const agent = await AgentModel.create({
          name: `${name} agent`,
          scope: "org",
          teams: [],
        });
        await AgentToolModel.create(agent.id, tool.id, {
          mcpServerId: server.id,
        });
        return agent;
      }),
    );

    // Without a conversation, both calls would otherwise share a connection.
    for (const agent of [...agents, ...agents]) {
      const result = await callAs({
        agentId: agent.id,
        userId: user.id,
        toolName: tool.name,
      });
      expect(result.isError).toBeFalsy();
    }

    expect(signedCalls).toEqual(
      [...agents, ...agents].map((agent) => ({
        caller: agent.id,
        accessKey: `key-archestra-agents-agent-${agent.id}`,
      })),
    );
  });

  test("discovery signs as the platform, and a session for no agent fails closed", async ({
    makeUser,
  }) => {
    const user = await makeUser();
    const { server } = await installAwsServer(user.id);
    const listTools = (
      caller: Parameters<typeof mcpClient.withSkillsSession>[0]["caller"],
    ) =>
      mcpClient.withSkillsSession({
        caller,
        mcpServerId: server.id,
        run: (client) => client.listTools(),
      });

    await listTools({ kind: "internal", purpose: "skills-discovery" });
    expect(listedBy).toEqual(["key-archestra-agents-platform"]);

    await expect(
      listTools({ kind: "caller", userId: user.id }),
    ).rejects.toThrow("this call has no agent");
  });

  test("a changed role is used from the next call on", async ({ makeUser }) => {
    const user = await makeUser();
    const { tool, server, catalog } = await installAwsServer(user.id);
    const agent = await AgentModel.create({
      name: "agent",
      scope: "org",
      teams: [],
    });
    await AgentToolModel.create(agent.id, tool.id, { mcpServerId: server.id });
    const call = () =>
      callAs({ agentId: agent.id, userId: user.id, toolName: tool.name });

    await call();
    await InternalMcpCatalogModel.update(catalog.id, {
      awsIamConfig: {
        roleArn: "arn:aws:iam::123456789012:role/restricted-agents",
        region: "us-east-1",
        service: "bedrock-agentcore",
      },
    });
    await call();

    expect(signedCalls.map(({ accessKey }) => accessKey)).toEqual([
      `key-archestra-agents-agent-${agent.id}`,
      `key-restricted-agents-agent-${agent.id}`,
    ]);
  });
});

async function callAs(params: {
  agentId: string;
  userId: string;
  toolName: string;
}) {
  return mcpClient.executeToolCallForOwner(
    {
      id: `call-${params.agentId}`,
      name: params.toolName,
      arguments: { caller: params.agentId },
    },
    agentOwner(params.agentId),
    {
      tokenId: "token",
      teamId: null,
      isOrganizationToken: false,
      userId: params.userId,
    },
  );
}

async function installAwsServer(userId: string) {
  const catalog = await InternalMcpCatalogModel.create({
    name: "agentcore-gateway",
    serverType: "remote",
    serverUrl: SERVER_URL,
    awsIamConfig: {
      roleArn: ROLE_ARN,
      region: "us-east-1",
      service: "bedrock-agentcore",
    },
  });
  const server = await McpServerModel.create({
    name: "agentcore-gateway",
    catalogId: catalog.id,
    serverType: "remote",
    ownerId: userId,
  });
  const tool = await ToolModel.createToolIfNotExists({
    name: "agentcore-gateway__lookup",
    description: "Look something up",
    parameters: {},
    catalogId: catalog.id,
  });
  return { tool, server, catalog };
}
