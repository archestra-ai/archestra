import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { queryService } from "@/knowledge-base";
import { UserTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";

/**
 * An external MCP client reaches `query_knowledge_sources` through this route,
 * and whatever the tool puts on `content` is handed back to it verbatim. So the
 * decision "may this caller be given binary payloads as MCP image parts" has to
 * hold at the route, not just at the tool: these tests drive the real HTTP
 * surface rather than `executeArchestraTool`, because the gateway building its
 * context without `deliversMediaAsImageParts` is the whole mechanism.
 */

const IMAGE_PAYLOAD = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4H";
const MIME = "image/webp";

function makeMcpHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
}

describe("MCP gateway knowledge media payloads", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns a retrieved image inline as its data URL, never as an image part", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const kb = await makeKnowledgeBase(org.id);
    await makeKnowledgeBaseConnector(kb.id, org.id);
    const agent = await makeAgent({
      name: "Gateway KB Agent",
      organizationId: org.id,
      agentType: "mcp_gateway",
      knowledgeBaseIds: [kb.id],
      accessAllTools: true,
    });
    const token = await UserTokenModel.create(user.id, org.id);

    // The query service always splits a media chunk into descriptor + payload;
    // who gets which shape is decided downstream of it.
    const querySpy = vi.spyOn(queryService, "query").mockResolvedValueOnce([
      {
        content: `[image: lobsters.webp (${MIME})]`,
        score: 0.95,
        chunkIndex: 0,
        metadata: {},
        ref: "doc-1#0",
        citation: {
          title: "lobsters.webp",
          sourceUrl: null,
          documentId: "doc-1",
          sourceId: null,
          connectorType: "jira",
        },
        media: { kind: "image", mimeType: MIME, data: IMAGE_PAYLOAD },
      },
    ] as never);

    const response = await app.inject({
      method: "POST",
      url: `/v1/mcp/${agent.id}`,
      headers: makeMcpHeaders(token.value),
      payload: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}query_knowledge_sources`,
          arguments: { query: "lobsters" },
        },
        id: 2,
      },
    });
    querySpy.mockRestore();

    const content = response.json().result.content as Array<{
      type: string;
      text?: string;
    }>;

    // One text block — an external client's parser is not handed a content
    // block kind it never saw from this tool before.
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");

    const parsed = JSON.parse(content[0].text as string);
    expect(parsed.results[0].content).toBe(
      `data:${MIME};base64,${IMAGE_PAYLOAD}`,
    );
    // `media` is an internal carrier between the query service and this
    // decision; it must not reach the wire in either shape.
    expect(parsed.results[0].media).toBeUndefined();
  });
});
