import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { vi } from "vitest";
import { beforeEach, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

vi.mock("@/logging");

import logger from "@/logging";

const EDIT_CONFIG_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}edit_mcp_config`;
const CREATE_TOOL = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server`;

const SECRET_VALUE = "sk-log-PLAINTEXT-must-not-escape";

let testAgent: Agent;
let mockContext: ArchestraContext;
let organizationId: string;

beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
  const org = await makeOrganization();
  organizationId = org.id;
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  testAgent = await makeAgent({ name: "Test Agent", organizationId: org.id });
  mockContext = {
    agent: { id: testAgent.id, name: testAgent.name },
    userId: user.id,
    organizationId: org.id,
  };
});

function loggedText(): string {
  return JSON.stringify(vi.mocked(logger.info).mock.calls);
}

/**
 * These handlers log their arguments on entry. Pino's global redaction only
 * censors credential-shaped keys at the top level and one below it
 * (`REDACTED_LOG_PATHS`), which does not reach `environment[].value`.
 */
test("edit_mcp_config keeps a caller-supplied secret out of the application log", async ({
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog({
    name: `logged-${crypto.randomUUID().slice(0, 8)}`,
    serverType: "local",
    organizationId,
    localConfig: { command: "echo" },
  });

  await executeArchestraTool(
    EDIT_CONFIG_TOOL,
    {
      id: catalog.id,
      environment: [
        {
          key: "NETBOX_TOKEN",
          type: "secret",
          value: SECRET_VALUE,
          promptOnInstallation: false,
        },
      ],
    },
    mockContext,
  );

  expect(vi.mocked(logger.info)).toHaveBeenCalled();
  expect(loggedText()).not.toContain(SECRET_VALUE);
  // The key is still logged, so the entry stays useful for debugging.
  expect(loggedText()).toContain("NETBOX_TOKEN");
});

test("create_mcp_server keeps a caller-supplied secret out of the application log", async () => {
  await executeArchestraTool(
    CREATE_TOOL,
    {
      name: `logged-create-${crypto.randomUUID().slice(0, 8)}`,
      serverType: "local",
      command: "echo",
      environment: [
        {
          key: "NETBOX_TOKEN",
          type: "secret",
          value: SECRET_VALUE,
          promptOnInstallation: false,
        },
      ],
    },
    mockContext,
  );

  expect(vi.mocked(logger.info)).toHaveBeenCalled();
  expect(loggedText()).not.toContain(SECRET_VALUE);
});
