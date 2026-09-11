import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import config from "@/config";
import { InternalMcpCatalogModel, UserTokenModel } from "@/models";
import AppaProxySessionModel from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import { canonicalNativeMcpArguments } from "@/services/appa-codex-native-bridge";
import { DurableAppaNativeMcpExecutionService } from "@/services/appa-native-mcp-execution";
import { expect, test } from "@/test";
import mcpGatewayRoutes from "./index";

for (const denied of [false, true]) {
  test(
    denied
      ? "native gateway policy denial fails closed without dispatch"
      : "native gateway-owned mutation persists a successful receipt and replays it",
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      seedAndAssignArchestraTools,
      makeTool,
      makeAgentTool,
      makeToolPolicy,
    }) => {
      config.llmProxy.appaHook = {
        url: "http://appa.invalid",
        timeoutMs: 100,
        sessionHmacSecret: "synthetic-native-gateway-receipt-secret",
        nativeCodexEnabled: true,
      };
      const organization = await makeOrganization();
      const user = await makeUser();
      await makeMember(user.id, organization.id, { role: "admin" });
      const gateway = await makeAgent({
        organizationId: organization.id,
        agentType: "mcp_gateway",
      });
      const profile = await makeAgent({
        organizationId: organization.id,
        agentType: "llm_proxy",
      });
      const name = denied
        ? "native_fixture__blocked"
        : "archestra__create_mcp_server";
      const args: Record<string, unknown> = denied
        ? { recipient: "external" }
        : {
            name: "Native Receipt Catalog",
            serverType: "remote",
            serverUrl: "https://example.invalid/mcp",
          };
      if (denied) {
        const tool = await makeTool({ name });
        await makeAgentTool(gateway.id, tool.id);
        await makeToolPolicy(tool.id, {
          action: "block_always",
          reason: "Synthetic policy stop",
          conditions: [
            { key: "recipient", operator: "equal", value: "external" },
          ],
        });
      } else {
        await seedAndAssignArchestraTools(gateway.id);
      }
      const token = await UserTokenModel.create(user.id, organization.id);
      const threadId = randomUUID();
      const turn = await AppaProxySessionModel.enterTurn({
        profileId: profile.id,
        ownerScopeHash: `native-owner-${randomUUID()}`,
        clientSessionId: threadId,
        rootId: `native-root-${randomUUID()}`,
        turnId: randomUUID(),
        maxSessionsPerOwner: 100,
      });
      const scope = {
        sessionId: turn.session.id,
        ownerScopeHash: turn.session.ownerScopeHash,
        turnId: turn.turnId,
      };
      const callId = `call_appa_${randomUUID().replaceAll("-", "")}`;
      const canonical = canonicalNativeMcpArguments(args);
      const executionArgs = {
        tool_name: name,
        tool_args: args,
        wire_context: {
          call_id: callId,
          thread_id: threadId,
          item_id: `fc_${callId}`,
        },
      };
      const executionCanonical = canonicalNativeMcpArguments(executionArgs);
      // The real runtime authorization boundary is covered by the stock suite.
      // This fixture supplies its issued intent to exercise actual gateway paths.
      const frame = await AppaProxyWireModel.createFrame({
        ...scope,
        kind: "model_response",
        protocol: "codex-native-response/v1",
        requestHash: "native-gateway-fixture",
        idempotencyKey: callId,
        payload: {
          calls: [
            {
              id: callId,
              name: "archestra__run_tool",
              arguments: executionCanonical,
            },
          ],
          response: {
            output: [
              {
                type: "function_call",
                id: `fc_${callId}`,
                call_id: callId,
                namespace: "mcp__gateway",
                name,
                arguments: canonical,
              },
            ],
          },
        },
        expiresAt: new Date(Date.now() + 60_000),
      });
      await AppaProxyWireModel.addAliases({
        ...scope,
        frameId: frame.id,
        aliases: [
          {
            kind: "call",
            position: 0,
            wireId: callId,
            metadata: {
              purpose: "native_call",
              principalUserId: user.id,
              gatewayProfileId: gateway.id,
              threadId,
              itemId: `fc_${callId}`,
              toolName: name,
              argumentsCanonical: canonical,
              executionArgumentsCanonical: executionCanonical,
            },
          },
        ],
      });
      await AppaProxyWireModel.markReady({ ...scope, frameId: frame.id });
      await AppaProxyWireModel.markIssued({ ...scope, frameId: frame.id });
      await AppaProxySessionModel.releaseTurn(turn);
      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      try {
        await app.register(mcpGatewayRoutes);
        const invoke = () =>
          app.inject({
            method: "POST",
            url: `/v1/mcp/${gateway.id}`,
            headers: {
              authorization: `Bearer ${token.value}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            payload: {
              jsonrpc: "2.0",
              id: randomUUID(),
              method: "tools/call",
              params: {
                name: "archestra__run_tool",
                arguments: executionArgs,
              },
            },
          });
        const first = await invoke();
        expect(first.statusCode, first.body).toBe(200);
        const receipt =
          await new DurableAppaNativeMcpExecutionService().getNativeMcpExecutionOutcome(
            { ...scope, callId },
          );
        expect(receipt.status, first.body).toBe(
          denied ? "indeterminate" : "success",
        );
        expect(Boolean(first.json().result.isError)).toBe(denied);
        if (denied) {
          expect(first.json().result.structuredContent).toEqual({
            status: "indeterminate_execution",
          });
        } else {
          expect(
            await InternalMcpCatalogModel.findByName("Native Receipt Catalog"),
          ).toBeTruthy();
        }
        const repeated = await invoke();
        expect(repeated.statusCode, repeated.body).toBe(200);
        expect(repeated.json().result.content).toEqual(
          first.json().result.content,
        );
        expect(repeated.json().result.structuredContent).toEqual(
          first.json().result.structuredContent,
        );
      } finally {
        await app.close();
      }
    },
  );
}
