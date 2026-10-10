import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, vi } from "vitest";
import config from "@/config";
import {
  AgentModel,
  ConnectionSetupModel,
  MemberModel,
  OrganizationModel,
} from "@/models";
import { CLAUDE_CODE_GUARD_CLIENT } from "@/services/agent-connection-setup/guard/clients";
import { buildStartupGuardInstallSection } from "@/services/agent-connection-setup/guard/startup-guard";
import { issueConnectionInstructionsToken } from "@/services/connection-instructions-token";
import { expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./connection-setup.routes";

vi.mock("@/auth");
vi.mock("@/cache-manager");

import { userHasPermission } from "@/auth";

// biome-ignore lint/correctness/useHookAtTopLevel: registers Vitest route fixtures, not a React hook
const ctx = useRouteTestApp(routes);
afterEach(() => vi.useRealTimers());

test("installed connections fetch updated prompts after ticket expiry, and observe disable/re-enable", async ({
  makeMember,
  makeAgent,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId);
  vi.mocked(userHasPermission).mockResolvedValue(true);
  const gateway = await makeAgent({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    agentType: "mcp_gateway",
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    clientId: "claude-code",
    platform: "linux",
    baseUrl: "https://example.com/v1",
    mcpGatewayId: gateway.id,
    expiresAt: new Date(Date.now() + 60000),
  });
  await ConnectionSetupModel.claimByToken({ rawToken });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + 16 * 60 * 1000));
  expect(setup.expiresAt.getTime()).toBeLessThan(Date.now());
  const token = issueConnectionInstructionsToken({
    setupId: setup.id,
    secret: config.auth.secret ?? "",
  });
  const fetchInstructions = (credential = token) =>
    ctx.app.inject({
      method: "GET",
      url: "/v1/connection-instructions",
      headers: { authorization: `Bearer ${credential}` },
    });
  await OrganizationModel.patch(ctx.organizationId, {
    connectionRuntimeHandoffEnabled: true,
    connectionRuntimeHandoffInstructions: "Initial guidance",
  });
  const initial = await fetchInstructions();
  expect(initial.statusCode, initial.body).toBe(200);
  expect(initial.json().instructions).toBe("Initial guidance");
  expect(initial.headers["cache-control"]).toBe("no-store");
  await OrganizationModel.patch(ctx.organizationId, {
    connectionRuntimeHandoffInstructions: "Updated guidance",
  });
  const updated = await fetchInstructions();
  expect(updated.json().instructions).toBe("Updated guidance");
  expect(updated.json().version).not.toBe(initial.json().version);
  await OrganizationModel.patch(ctx.organizationId, {
    connectionRuntimeHandoffEnabled: false,
  });
  expect((await fetchInstructions()).json().instructions).toBeNull();
  await OrganizationModel.patch(ctx.organizationId, {
    connectionRuntimeHandoffEnabled: true,
  });
  expect((await fetchInstructions()).json().instructions).toBe(
    "Updated guidance",
  );
  expect((await fetchInstructions(rawToken)).statusCode).toBe(401);
  await MemberModel.deleteAllByUserId(ctx.user.id);
  expect((await fetchInstructions()).statusCode).toBe(403);
});

test("unsigned requests and unconsumed installations cannot read managed instructions", async ({
  makeMember,
  makeAgent,
}) => {
  const missing = await ctx.app.inject({
    method: "GET",
    url: "/v1/connection-instructions",
  });
  expect(missing.statusCode).toBe(401);
  await makeMember(ctx.user.id, ctx.organizationId);
  const gateway = await makeAgent({
    organizationId: ctx.organizationId,
    agentType: "mcp_gateway",
  });
  const { setup } = await ConnectionSetupModel.create({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    clientId: "claude-code",
    baseUrl: "https://example.com/v1",
    mcpGatewayId: gateway.id,
    expiresAt: new Date(Date.now() + 60000),
  });
  const token = issueConnectionInstructionsToken({
    setupId: setup.id,
    secret: config.auth.secret ?? "",
  });
  const response = await ctx.app.inject({
    method: "GET",
    url: "/v1/connection-instructions",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(403);
});

test("revoking gateway permissions and deleting the gateway revoke instruction delivery", async ({
  makeMember,
  makeAgent,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId);
  vi.mocked(userHasPermission).mockResolvedValue(true);
  const gateway = await makeAgent({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    agentType: "mcp_gateway",
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    clientId: "claude-code",
    baseUrl: "https://example.com/v1",
    mcpGatewayId: gateway.id,
    expiresAt: new Date(Date.now() + 60000),
  });
  await ConnectionSetupModel.claimByToken({ rawToken });
  const token = issueConnectionInstructionsToken({
    setupId: setup.id,
    secret: config.auth.secret ?? "",
  });
  const fetchInstructions = () =>
    ctx.app.inject({
      method: "GET",
      url: "/v1/connection-instructions",
      headers: { authorization: `Bearer ${token}` },
    });
  expect((await fetchInstructions()).statusCode).toBe(200);
  vi.mocked(userHasPermission).mockResolvedValue(false);
  expect((await fetchInstructions()).statusCode).toBe(403);
  vi.mocked(userHasPermission).mockResolvedValue(true);
  await AgentModel.delete(gateway.id);
  expect((await fetchInstructions()).statusCode).toBe(403);
});

test("saved organization changes reach the next installed agent launch through the live endpoint", async ({
  makeMember,
  makeAgent,
}) => {
  await makeMember(ctx.user.id, ctx.organizationId);
  vi.mocked(userHasPermission).mockResolvedValue(true);
  const gateway = await makeAgent({
    organizationId: ctx.organizationId,
    authorId: ctx.user.id,
    agentType: "mcp_gateway",
  });
  const { setup, rawToken } = await ConnectionSetupModel.create({
    organizationId: ctx.organizationId,
    userId: ctx.user.id,
    clientId: "claude-code",
    baseUrl: "https://example.com/v1",
    mcpGatewayId: gateway.id,
    expiresAt: new Date(Date.now() + 60000),
  });
  await ConnectionSetupModel.claimByToken({ rawToken });
  const origin = await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const home = await mkdtemp(path.join(tmpdir(), "live instruction update "));
  const exec = promisify(execFile);
  const env = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/bash",
    PATH: `${home}:${process.env.PATH}`,
    ARCHESTRA_CLAUDE_GUARD: "0",
  };
  try {
    await writeFile(
      path.join(home, "claude"),
      '#!/bin/sh\nif [ "$1" = "--append-system-prompt-file" ]; then cat "$2"; else printf no-managed-instructions; fi\n',
    );
    await chmod(path.join(home, "claude"), 0o755);
    const script = buildStartupGuardInstallSection(
      {
        appName: "Test Platform",
        healthUrl: null,
        proxy: null,
        skills: null,
        mcp: {
          serverName: "gateway",
          url: `${origin}/v1/mcp/${gateway.id}`,
          ref: gateway.id,
        },
        runtimeHandoffInstructions: null,
        managedInstructionsSource: {
          url: `${origin}/v1/connection-instructions`,
          token: issueConnectionInstructionsToken({
            setupId: setup.id,
            secret: config.auth.secret ?? "",
          }),
        },
      },
      CLAUDE_CODE_GUARD_CLIENT,
    );
    await writeFile(
      path.join(home, "install.sh"),
      `set -eu\nsay() { :; }\nok() { :; }\n${script}`,
    );
    await exec("bash", [path.join(home, "install.sh")], { env });
    const launch = async () =>
      (
        await exec("bash", ["-c", 'source "$HOME/.bashrc"; claude -p work'], {
          env,
        })
      ).stdout;
    await OrganizationModel.patch(ctx.organizationId, {
      connectionRuntimeHandoffEnabled: true,
      connectionRuntimeHandoffInstructions: "Initial managed guidance",
    });
    expect(await launch()).toBe("Initial managed guidance");
    await OrganizationModel.patch(ctx.organizationId, {
      connectionRuntimeHandoffInstructions: "Replacement managed guidance",
    });
    expect(await launch()).toBe("Replacement managed guidance");
    await OrganizationModel.patch(ctx.organizationId, {
      connectionRuntimeHandoffEnabled: false,
    });
    expect(await launch()).toBe("no-managed-instructions");
    await OrganizationModel.patch(ctx.organizationId, {
      connectionRuntimeHandoffEnabled: true,
    });
    expect(await launch()).toBe("Replacement managed guidance");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
