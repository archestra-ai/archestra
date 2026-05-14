import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import { InternalMcpCatalogModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

const mockHasPermission = hasPermission as Mock;

/**
 * GET /api/internal_mcp_catalog/:catalogId/children must NOT leak the
 * plaintext values of preset-scoped secrets. The endpoint serves the Presets
 * panel; before this hardening it called expandSecrets() which merged the
 * resolved secret bag into presetFieldValues and rendered as
 * `preset_sec=<plaintext>` in the UI.
 *
 * Contract:
 *   - presetFieldValues on the response carries ONLY non-secret preset
 *     overrides (the JSONB column as stored).
 *   - presetSecretId is returned as-is; consumers infer "the secret keys are
 *     filled" from `presetSecretId != null` (the same heuristic the install
 *     dialog's preset-fallback-fields uses).
 */
describe("GET /api/internal_mcp_catalog/:catalogId/children — secret values are not leaked", () => {
  let app: FastifyInstance;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send({
          error: { message: error.message, type: error.type },
        });
      }
      const err = error as Error & { statusCode?: number };
      const status = err.statusCode ?? 500;
      return reply.status(status).send({ error: { message: err.message } });
    });
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          user: User;
          organizationId: string;
        }
      ).user = user;
      (
        request as typeof request & {
          user: User;
          organizationId: string;
        }
      ).organizationId = organization.id;
    });
    await app.register(internalMcpCatalogRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("secret-typed promptOnPreset value is NOT merged into presetFieldValues on the response", async ({
    makeInternalMcpCatalog,
    makeSecret,
  }) => {
    const parent = await makeInternalMcpCatalog({
      name: "no-leak-parent",
      serverType: "local",
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          {
            key: "preset_env",
            type: "plain_text",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
          {
            key: "preset_sec",
            type: "secret",
            promptOnInstallation: false,
            promptOnPreset: true,
            required: false,
          },
        ],
        transportType: "streamable-http",
        httpPort: 8080,
        httpPath: "/mcp",
      },
    });

    const presetSecretBag = await makeSecret({
      name: "child-preset-secret-bag",
      secret: { preset_sec: "leakable-plaintext" },
    });

    const child = await InternalMcpCatalogModel.create({
      name: `${parent.name}-ildar`,
      childName: "ildar",
      parentCatalogItemId: parent.id,
      serverType: parent.serverType,
      localConfig: parent.localConfig,
      presetFieldValues: { preset_env: "ildar_preset_env" },
      presetSecretId: presetSecretBag.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${parent.id}/children`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{
      id: string;
      presetFieldValues: Record<string, unknown>;
      presetSecretId: string | null;
    }>;

    const childRow = body.find((r) => r.id === child.id);
    expect(childRow).toBeTruthy();

    // Heuristic-only: presetSecretId surfaces existence of the bag without
    // exposing its contents.
    expect(childRow?.presetSecretId).toBe(presetSecretBag.id);

    // The wire shape carries only the non-secret preset overrides — secret
    // keys must not appear here, and certainly not their plaintext values.
    expect(childRow?.presetFieldValues).toEqual({
      preset_env: "ildar_preset_env",
    });
    expect(childRow?.presetFieldValues).not.toHaveProperty("preset_sec");

    // Defense in depth: the plaintext must not appear anywhere in the
    // serialized response payload.
    expect(response.body).not.toContain("leakable-plaintext");
  });
});
