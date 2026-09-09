import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
// The dependency-free E2E fixture intentionally ships as plain JavaScript.
// @ts-expect-error -- no declaration file is needed outside these route tests.
import { createA2aFixtureServer } from "../../../../e2e-tests/fixtures/a2a-test-agent/server.mjs";

export type FixtureAuthMode = "none" | "bearer" | "api-key" | "either";

export function makeAgentCard(
  authMode: FixtureAuthMode = "none",
  overrides: Record<string, unknown> = {},
) {
  const security =
    authMode === "none"
      ? { securitySchemes: {}, securityRequirements: [] }
      : authMode === "bearer"
        ? {
            securitySchemes: {
              bearerAuth: { type: "http", scheme: "bearer" },
            },
            securityRequirements: [{ bearerAuth: [] }],
          }
        : authMode === "api-key"
          ? {
              securitySchemes: {
                apiKeyAuth: {
                  type: "apiKey",
                  in: "header",
                  name: "X-API-Key",
                },
              },
              securityRequirements: [{ apiKeyAuth: [] }],
            }
          : {
              securitySchemes: {
                bearerAuth: { type: "http", scheme: "bearer" },
                apiKeyAuth: {
                  type: "apiKey",
                  in: "header",
                  name: "X-API-Key",
                },
              },
              securityRequirements: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
            };

  return {
    name: "Route Test Agent",
    description: "A deterministic outbound A2A route-test target.",
    version: "1.0.0",
    supportedInterfaces: [
      {
        url: "http://127.0.0.1:9191/a2a",
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    capabilities: { streaming: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
    ...security,
    ...overrides,
  };
}

export async function startA2aDiscoveryFixture(
  authMode: FixtureAuthMode = "none",
  hostname = "127.0.0.1",
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createA2aFixtureServer({ authMode }) as Server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, hostname, resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://${hostname}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
