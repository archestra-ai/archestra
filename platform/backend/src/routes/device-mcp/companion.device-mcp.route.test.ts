import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { DeviceMcpConfig } from "@archestra/shared/device-mcp";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import { DeviceMcpCompanion } from "@/device-mcp-client/client";
import OrganizationModel from "@/models/organization";
import ToolModel from "@/models/tool";
import UserTokenModel from "@/models/user-token";
import mcpGatewayRoutes from "@/routes/mcp-gateway";
import { deviceMcpService } from "@/services/device-mcp";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import { agentOwner } from "@/types";
import deviceMcpRoutes from "./device-mcp.routes";

const fixture = fileURLToPath(
  new URL("../../test/fixtures/device-mcp.mjs", import.meta.url),
);
const fixtureConfig: DeviceMcpConfig = {
  protocolVersion: 1,
  version: "fixture-1",
  platforms: {
    darwin: { command: process.execPath, args: [fixture] },
    win32: { command: process.execPath, args: [fixture] },
  },
  tools: [
    {
      name: "echo",
      description: "Return the supplied text",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          delayMs: { type: "integer", minimum: 0, maximum: 5000 },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  ],
};

describe("real companion and device relay", () => {
  const ctx = useRouteTestApp(async (app) => {
    await app.register(deviceMcpRoutes);
    await app.register(mcpGatewayRoutes);
  });

  test.skipIf(process.platform !== "darwin")(
    "macOS standalone CLI pairs in a real terminal and exchanges a gateway call over TCP",
    async ({
      makeMember,
      makeInternalMcpCatalog,
      makeAgent,
      makeAgentTool,
    }) => {
      const bundle = fileURLToPath(
        new URL("../../../dist/device-mcp-client.mjs", import.meta.url),
      );
      execFileSync(process.execPath, [
        fileURLToPath(
          new URL("../../device-mcp-client/build.mjs", import.meta.url),
        ),
      ]);
      await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
      await OrganizationModel.patch(ctx.organizationId, {
        deviceMcpEnabled: true,
      });
      const catalog = await makeInternalMcpCatalog({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        serverType: "device",
        deviceConfig: fixtureConfig,
      });
      const [tool] = await ToolModel.findByCatalogId(catalog.id, {
        kind: "caller",
        userId: ctx.user.id,
        organizationId: ctx.organizationId,
      });
      const agent = await makeAgent({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        agentType: "mcp_gateway",
        accessAllTools: false,
        toolExposureMode: "full",
      });
      await makeAgentTool(agent.id, tool.id, {
        credentialResolutionMode: "dynamic",
      });
      const gatewayToken = await UserTokenModel.create(
        ctx.user.id,
        ctx.organizationId,
      );
      const pairing = await deviceMcpService.pair({
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        catalogId: catalog.id,
        name: "Standalone CLI fixture",
        replaceExisting: false,
      });
      const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
      // expect(1) gives the actual CLI a PTY even when Vitest itself uses
      // pipes. Approval still waits for the test to inspect the pending state.
      const terminalDir = mkdtempSync(join(tmpdir(), "device-mcp-terminal-"));
      const terminalScript = join(terminalDir, "companion.exp");
      writeFileSync(
        terminalScript,
        `set timeout 15
log_user 1
spawn -noecho {*}$argv
expect {
  "Type CONNECT to pair this device" {}
  eof {exit 70}
  timeout {exit 71}
}
puts "CONSENT_READY"
flush stdout
if {[gets stdin approval] < 0 || $approval ne "CONNECT"} {exit 72}
send -- "CONNECT[format %c 13]"
expect eof
set result [wait]
exit [lindex $result 3]
`,
      );
      const cli = spawn(
        "/usr/bin/expect",
        [
          terminalScript,
          process.execPath,
          bundle,
          "--url",
          address,
          "--code",
          pairing.code,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let output = "";
      cli.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      cli.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      const exited = once(cli, "exit");
      try {
        await expect
          .poll(() => output, { timeout: 10_000 })
          .toContain("CONSENT_READY");
        expect(
          (
            await deviceMcpService.list({
              organizationId: ctx.organizationId,
              userId: ctx.user.id,
              catalogId: catalog.id,
            })
          )[0].status,
        ).toBe("setup_required");
        cli.stdin.write("CONNECT\n");
        await expect
          .poll(() => output, { timeout: 10_000 })
          .toContain("Device MCP is ready");
        expect(
          (
            await deviceMcpService.list({
              organizationId: ctx.organizationId,
              userId: ctx.user.id,
              catalogId: catalog.id,
            })
          )[0].status,
        ).toBe("online");
        const response = await fetch(`${address}/v1/mcp/${agent.id}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${gatewayToken.value}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
              name: tool.name,
              arguments: { text: "standalone CLI TCP roundtrip" },
            },
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          result: {
            content: [{ type: "text", text: "standalone CLI TCP roundtrip" }],
            structuredContent: { executionCount: 1 },
          },
        });
        await deviceMcpService.revoke({
          id: pairing.id,
          organizationId: ctx.organizationId,
          userId: ctx.user.id,
        });
        await Promise.race([
          exited,
          delay(5000).then(() => {
            throw new Error(
              "Standalone companion did not exit after token revocation",
            );
          }),
        ]);
        expect(cli.exitCode).toBe(1);
        expect(output).toContain("Device connection request failed (401)");
      } finally {
        if (cli.exitCode === null) cli.kill("SIGHUP");
        await exited;
        rmSync(terminalDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test("routes personal gateway and chat/runtime dispatch through the actual outbound companion and stdio MCP", async ({
    makeMember,
    makeInternalMcpCatalog,
    makeAgent,
    makeAgentTool,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      serverType: "device",
      deviceConfig: fixtureConfig,
    });
    const [tool] = await ToolModel.findByCatalogId(catalog.id, {
      kind: "caller",
      userId: ctx.user.id,
      organizationId: ctx.organizationId,
    });
    const agent = await makeAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      agentType: "mcp_gateway",
      accessAllTools: false,
      toolExposureMode: "full",
    });
    await makeAgentTool(agent.id, tool.id, {
      credentialResolutionMode: "dynamic",
    });
    const userToken = await UserTokenModel.create(
      ctx.user.id,
      ctx.organizationId,
    );
    const pairing = await deviceMcpService.pair({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      catalogId: catalog.id,
      name: "Fixture workstation",
      replaceExisting: false,
    });
    const address = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
    const platform = process.platform === "win32" ? "win32" : "darwin";
    const companion = new DeviceMcpCompanion(address, platform);
    const abort = new AbortController();
    await companion.pair(pairing.code, async ({ configDigest, launch }) => {
      expect(configDigest).toBe(pairing.configDigest);
      expect(launch).toEqual({ command: process.execPath, args: [fixture] });
      return true;
    });
    const running = companion.run(abort.signal).then(
      () => null,
      (error: Error) => error,
    );
    try {
      await expect
        .poll(
          async () =>
            (
              await deviceMcpService.list({
                organizationId: ctx.organizationId,
                userId: ctx.user.id,
                catalogId: catalog.id,
              })
            )[0].status,
          { timeout: 10_000 },
        )
        .toBe("online");
      const gateway = await ctx.app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${userToken.value}`,
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool.name, arguments: { text: "from gateway" } },
        },
      });
      expect(gateway.statusCode, gateway.body).toBe(200);
      expect(gateway.json().result, gateway.body).toMatchObject({
        content: [{ type: "text", text: "from gateway" }],
        structuredContent: { executionCount: 1 },
      });
      const dispatched = await mcpClient.executeToolCallForOwner(
        {
          id: "interactive-runtime-call",
          name: tool.name,
          arguments: { text: "from interactive execution" },
        },
        agentOwner(agent.id),
        {
          tokenId: userToken.token.id,
          organizationId: ctx.organizationId,
          userId: ctx.user.id,
          isUserToken: true,
          teamId: null,
          isOrganizationToken: false,
        },
      );
      expect(dispatched).toMatchObject({
        isError: false,
        content: [{ type: "text", text: "from interactive execution" }],
      });
      for (const context of [
        { isBackgroundExecution: true },
        { teamId: "team-identity" },
        { isOrganizationToken: true },
      ] satisfies Partial<TokenAuthContext>[]) {
        const refusedIdentity = await mcpClient.executeToolCallForOwner(
          {
            id: "refused-identity",
            name: tool.name,
            arguments: { text: "must not execute" },
          },
          agentOwner(agent.id),
          {
            tokenId: userToken.token.id,
            organizationId: ctx.organizationId,
            userId: ctx.user.id,
            isUserToken: true,
            teamId: null,
            isOrganizationToken: false,
            ...context,
          },
        );
        expect(refusedIdentity.isError).toBe(true);
      }
      const another = await makeUser();
      await makeMember(another.id, ctx.organizationId, { role: "admin" });
      const otherToken = await UserTokenModel.create(
        another.id,
        ctx.organizationId,
      );
      const refused = await ctx.app.inject({
        method: "POST",
        url: `/v1/mcp/${agent.id}`,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${otherToken.value}`,
        },
        payload: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: tool.name,
            arguments: { text: "must not use another device" },
          },
        },
      });
      expect(refused.statusCode, refused.body).toBe(200);
      expect(refused.json().result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringContaining("Connect your own device"),
          },
        ],
      });
      const final = await deviceMcpService.callTool({
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        catalogId: catalog.id,
        toolName: "echo",
        arguments: { text: "still isolated" },
      });
      expect(final.structuredContent).toEqual({ executionCount: 3 });
    } finally {
      abort.abort();
      expect(await running).toBeNull();
    }
  }, 30_000);
});
