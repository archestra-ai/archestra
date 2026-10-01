import Fastify, { type FastifyInstance } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { load as loadYaml } from "js-yaml";
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import { InternalMcpCatalogModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

vi.mock("@/auth");

const mockHasPermission = hasPermission as Mock;

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

const VALID_DEPLOYMENT_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
spec:
  template:
    spec:
      containers:
        - name: mcp
          image: registry.example.com/mcp:latest
`;

describe("internal MCP catalog deployment YAML routes", () => {
  let app: FastifyInstance;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
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
      if (hasZodFastifySchemaValidationErrors(error)) {
        return reply.status(400).send({
          error: { message: error.message, type: "api_validation_error" },
        });
      }
      const err = error as Error & { statusCode?: number };
      const status = err.statusCode ?? 500;
      return reply.status(status).send({ error: { message: err.message } });
    });
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organization.id;
    });
    await app.register(internalMcpCatalogRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function makeLocalCatalog() {
    return InternalMcpCatalogModel.create(
      {
        name: "local-server",
        serverType: "local",
        scope: "org",
        localConfig: { dockerImage: "registry.example.com/mcp:latest" },
      },
      { organizationId, authorId: user.id },
    );
  }

  describe("GET /api/internal_mcp_catalog/:id/deployment-yaml-preview", () => {
    test("returns a generated YAML template for a local catalog", async () => {
      const catalog = await makeLocalCatalog();

      const response = await app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${catalog.id}/deployment-yaml-preview`,
      });

      expect(response.statusCode).toBe(200);
      const { yaml } = response.json();
      expect(yaml).toContain("kind: Deployment");
      expect(yaml).toContain("name: mcp-server");
    });

    test("returns 404 for an unknown catalog id", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${UNKNOWN_ID}/deployment-yaml-preview`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("Catalog item not found");
    });

    test("rejects non-local catalogs with 400", async () => {
      const catalog = await InternalMcpCatalogModel.create(
        {
          name: "remote-server",
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          scope: "org",
        },
        { organizationId, authorId: user.id },
      );

      const response = await app.inject({
        method: "GET",
        url: `/api/internal_mcp_catalog/${catalog.id}/deployment-yaml-preview`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe(
        "Deployment YAML preview is only available for local MCP servers",
      );
    });
  });

  describe("POST /api/internal_mcp_catalog/validate-deployment-yaml", () => {
    test("returns valid:true for a well-formed Deployment manifest", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog/validate-deployment-yaml",
        payload: { yaml: VALID_DEPLOYMENT_YAML },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        valid: true,
        errors: [],
        warnings: expect.any(Array),
      });
    });

    test("returns valid:false with errors for a non-Deployment manifest", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog/validate-deployment-yaml",
        payload: { yaml: "apiVersion: v1\nkind: ConfigMap\n" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.valid).toBe(false);
      expect(body.errors).toContain('kind must be "Deployment"');
    });

    test("rejects an empty yaml body with 400", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/internal_mcp_catalog/validate-deployment-yaml",
        payload: { yaml: "" },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /api/internal_mcp_catalog/:id/reset-deployment-yaml", () => {
    test("clears a custom deployment spec and returns a fresh template", async () => {
      const catalog = await InternalMcpCatalogModel.create(
        {
          name: "local-server-with-custom-yaml",
          serverType: "local",
          scope: "org",
          localConfig: { dockerImage: "registry.example.com/mcp:latest" },
          deploymentSpecYaml: "apiVersion: apps/v1\nkind: Deployment\n",
        },
        { organizationId, authorId: user.id },
      );

      const response = await app.inject({
        method: "POST",
        url: `/api/internal_mcp_catalog/${catalog.id}/reset-deployment-yaml`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().yaml).toContain("kind: Deployment");
      const reloaded = await InternalMcpCatalogModel.findById(catalog.id);
      expect(reloaded?.deploymentSpecYaml).toBeNull();
    });

    test("returns 404 for an unknown catalog id", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/internal_mcp_catalog/${UNKNOWN_ID}/reset-deployment-yaml`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("Catalog item not found");
    });

    test("rejects non-local catalogs with 400", async () => {
      const catalog = await InternalMcpCatalogModel.create(
        {
          name: "remote-server",
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
          scope: "org",
        },
        { organizationId, authorId: user.id },
      );

      const response = await app.inject({
        method: "POST",
        url: `/api/internal_mcp_catalog/${catalog.id}/reset-deployment-yaml`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toBe(
        "Deployment YAML reset is only available for local MCP servers",
      );
    });
  });
});

describe("catalog YAML preserves operator configuration and protects dynamic authority", () => {
  const OPERATOR_YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
spec:
  template:
    spec:
      hostNetwork: true
      volumes:
        - name: host-root
          hostPath:
            path: /
      containers:
        - name: mcp
          image: registry.example.com/mcp:latest
          securityContext:
            privileged: true
`;

  let app: FastifyInstance;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
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
      if (hasZodFastifySchemaValidationErrors(error)) {
        return reply.status(400).send({
          error: { message: error.message, type: "api_validation_error" },
        });
      }
      const err = error as Error & { statusCode?: number };
      const status = err.statusCode ?? 500;
      return reply.status(status).send({ error: { message: err.message } });
    });
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organization.id;
    });
    await app.register(internalMcpCatalogRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("an administrator can keep static custom pod configuration", async () => {
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "local-yaml-server",
        serverType: "local",
        scope: "org",
        localConfig: { dockerImage: "registry.example.com/mcp:latest" },
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { deploymentSpecYaml: OPERATOR_YAML },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.deploymentSpecYaml,
    ).toBe(OPERATOR_YAML);
  });

  test("saving checks placeholder sources deferred by standalone validation", async () => {
    const yaml = OPERATOR_YAML.replace(
      "hostNetwork: true",
      `serviceAccountName: \${env.ACCOUNT}`,
    );
    const create = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "dynamic-authority",
        serverType: "local",
        localConfig: { command: "node" },
        deploymentSpecYaml: yaml,
      },
    });
    expect(create.statusCode, create.body).toBe(400);
    expect(create.json().error.message).toContain("serviceAccountName");
    const validate = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog/validate-deployment-yaml",
      payload: { yaml },
    });
    expect(validate.statusCode, validate.body).toBe(200);
    expect(validate.json().valid).toBe(true);
    expect(validate.json().errors).toEqual([]);
    expect(validate.json().warnings.join(" ")).toContain("serviceAccountName");
  });

  test("static template sources persist and are rechecked when only their definitions change", async () => {
    const yaml = OPERATOR_YAML.replace(
      "hostNetwork: true",
      `serviceAccountName: \${env.ACCOUNT}`,
    );
    const localConfig = {
      command: "node",
      environment: [
        {
          key: "ACCOUNT",
          type: "plain_text",
          promptOnInstallation: false,
          value: "approved-runtime",
        },
      ],
    };
    const create = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "static-template",
        serverType: "local",
        localConfig,
        deploymentSpecYaml: yaml,
      },
    });
    expect(create.statusCode, create.body).toBe(200);
    const id = create.json().id;
    const original = await InternalMcpCatalogModel.findById(id, {
      expandSecrets: false,
    });
    const update = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${id}`,
      payload: {
        localConfig: {
          ...localConfig,
          environment: [
            { ...localConfig.environment[0], promptOnInstallation: true },
          ],
        },
      },
    });
    expect(update.statusCode, update.body).toBe(400);
    expect(update.json().error.message).toContain("serviceAccountName");
    const unchanged = await InternalMcpCatalogModel.findById(id, {
      expandSecrets: false,
    });
    expect(unchanged?.localConfig).toEqual(original?.localConfig);
    expect(unchanged?.deploymentSpecYaml).toBe(original?.deploymentSpecYaml);
  });

  test("saving accepts flow placeholders and rejects malformed template syntax", async () => {
    const flowYaml = OPERATOR_YAML.replace(
      "image: registry.example.com/mcp:latest",
      `image: registry.example.com/mcp:latest\n          command: [\${archestra.command}]`,
    );
    const create = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "flow-template",
        serverType: "local",
        localConfig: { command: "node" },
        deploymentSpecYaml: flowYaml,
      },
    });
    expect(create.statusCode, create.body).toBe(200);
    const invalid = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${create.json().id}`,
      payload: { deploymentSpecYaml: "spec: [unterminated" },
    });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(invalid.json().error.message).toContain("YAML syntax error");
    expect(
      (await InternalMcpCatalogModel.findById(create.json().id))
        ?.deploymentSpecYaml,
    ).toBe(flowYaml);
  });

  test("editing environment definitions also updates flow-style templates", async () => {
    const yaml = OPERATOR_YAML.replace(
      "image: registry.example.com/mcp:latest",
      `image: registry.example.com/mcp:latest\n          command: [\${archestra.command}]\n          env:\n            - name: REMOVED\n              value: old-value`,
    );
    const create = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: {
        name: "flow-environment",
        serverType: "local",
        deploymentSpecYaml: yaml,
        localConfig: {
          command: "node",
          environment: [
            {
              key: "REMOVED",
              type: "plain_text",
              promptOnInstallation: false,
              value: "old-value",
            },
          ],
        },
      },
    });
    expect(create.statusCode, create.body).toBe(200);
    const update = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${create.json().id}`,
      payload: { localConfig: { command: "node", environment: [] } },
    });
    expect(update.statusCode, update.body).toBe(200);
    const stored = await InternalMcpCatalogModel.findById(create.json().id);
    const deployment = loadYaml(stored?.deploymentSpecYaml ?? "") as {
      spec: {
        template: {
          spec: {
            containers: { command: string[]; env?: { name: string }[] }[];
          };
        };
      };
    };
    expect(deployment.spec.template.spec.containers[0].command).toEqual([
      `\${archestra.command}`,
    ]);
    expect(deployment.spec.template.spec.containers[0].env ?? []).toEqual([]);
  });

  test("the validate endpoint accepts static operator pod settings", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog/validate-deployment-yaml",
      payload: { yaml: OPERATOR_YAML },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.valid).toBe(true);
  });
});
