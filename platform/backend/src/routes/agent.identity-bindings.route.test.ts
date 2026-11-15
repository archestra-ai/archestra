import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { AgentIdentityBindingModel, AuditLogModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import type { User } from "@/types";
import agentRoutes from "./agent";

const ENTRA_AGENT_IDENTITY = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";

describe("agent identity bindings", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;
  let editor: User;
  let agentId: string;
  let entraProviderId: string;
  let oktaProviderId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeAdmin,
      makeUser,
      makeMember,
      makeAgent,
      makeIdentityProvider,
    }) => {
      organizationId = (await makeOrganization()).id;
      admin = await makeAdmin();
      await makeMember(admin.id, organizationId, { role: "admin" });
      // May edit this one agent, but not identity providers.
      editor = await makeUser();
      await makeMember(editor.id, organizationId);
      agentId = (
        await makeAgent({
          organizationId,
          authorId: admin.id,
          access: { users: [editor.id], preset: "edit" },
        })
      ).id;
      entraProviderId = (
        await makeIdentityProvider(organizationId, {
          oidcConfig: {
            clientId: "sso-client",
            enterpriseManagedCredentials: {
              exchangeStrategy: "entra_obo",
              entraAgentId: { blueprintClientId: "blueprint-client" },
            },
          },
        })
      ).id;
      oktaProviderId = (
        await makeIdentityProvider(organizationId, {
          oidcConfig: {
            clientId: "sso-client",
            enterpriseManagedCredentials: {
              exchangeStrategy: "okta_managed",
              agentIdentity: {
                privateKeyPem: "agent-private-key",
                privateKeyId: "archestra-agents",
              },
            },
          },
        })
      ).id;
      app = await authenticatedRouteApp({
        organizationId,
        routes: [agentRoutes],
        auditLog: true,
      });
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("binds identities at several providers for a user who may update identity providers, and audits it", async () => {
    const bindings = [
      { identityProviderId: entraProviderId, externalId: ENTRA_AGENT_IDENTITY },
      { identityProviderId: oktaProviderId, externalId: "wlp-agent-1" },
    ];

    const response = await replace(admin, agentId, bindings);

    expect(response.statusCode).toBe(200);
    expect(sortBindings(response.json().bindings)).toEqual(
      sortBindings(bindings),
    );
    const read = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/identity-bindings`,
      headers: { [USER_HEADER]: editor.id },
    });
    expect(sortBindings(read.json().bindings)).toEqual(sortBindings(bindings));
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: agentId,
      action: "agent.updated",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    expect(data[0].before).toMatchObject({ identityBindings: [] });
    expect(
      sortBindings(
        (data[0].after as { identityBindings: Binding[] }).identityBindings,
      ),
    ).toEqual(sortBindings(bindings));
  });

  test("refuses a change from an agent editor without identityProvider:update", async () => {
    const response = await replace(editor, agentId, [
      { identityProviderId: oktaProviderId, externalId: "wlp-agent-1" },
    ]);

    expect(response.statusCode).toBe(403);
    expect(await AgentIdentityBindingModel.findForAgent(agentId)).toEqual([]);
  });

  test("lets an agent editor resubmit the bindings unchanged", async () => {
    await AgentIdentityBindingModel.replaceForAgent({
      agentId,
      bindings: [
        {
          identityProviderId: entraProviderId,
          externalId: ENTRA_AGENT_IDENTITY,
        },
      ],
    });

    const response = await replace(editor, agentId, [
      {
        identityProviderId: entraProviderId,
        externalId: ENTRA_AGENT_IDENTITY,
      },
    ]);

    expect(response.statusCode).toBe(200);
  });

  test("refuses an identity already bound to another agent, in any case", async ({
    makeAgent,
  }) => {
    await AgentIdentityBindingModel.replaceForAgent({
      agentId,
      bindings: [
        { identityProviderId: oktaProviderId, externalId: "wlp-agent-1" },
      ],
    });
    const other = await makeAgent({ organizationId, authorId: admin.id });

    const response = await replace(admin, other.id, [
      { identityProviderId: oktaProviderId, externalId: "WLP-AGENT-1" },
    ]);

    expect(response.statusCode).toBe(409);
    expect(await AgentIdentityBindingModel.findForAgent(other.id)).toEqual([]);
  });

  test("refuses an Entra agent identity that is not a GUID", async () => {
    const response = await replace(admin, agentId, [
      { identityProviderId: entraProviderId, externalId: "agent-alpha" },
    ]);

    expect(response.statusCode).toBe(400);
  });

  test.for([
    ["no Tool Authentication", { clientId: "sso-client" }],
    [
      "Agent Identities without a key",
      {
        clientId: "sso-client",
        enterpriseManagedCredentials: {
          exchangeStrategy: "okta_managed",
          agentIdentity: { requireAgentIdentity: true },
        },
      },
    ],
    [
      "SPIFFE agent identities, which need no binding",
      {
        clientId: "sso-client",
        enterpriseManagedCredentials: {
          exchangeStrategy: "rfc8693",
          agentIdentity: { source: "spiffe" },
        },
      },
    ],
  ] as const)("refuses a provider with %s", async ([, oidcConfig], {
    makeIdentityProvider,
  }) => {
    const provider = await makeIdentityProvider(organizationId, { oidcConfig });

    const response = await replace(admin, agentId, [
      { identityProviderId: provider.id, externalId: "wlp-agent-1" },
    ]);

    expect(response.statusCode).toBe(400);
  });

  test("keeps a binding left at a provider that switched to SPIFFE IDs while another changes", async ({
    makeIdentityProvider,
  }) => {
    const spiffeProvider = await makeIdentityProvider(organizationId, {
      oidcConfig: {
        clientId: "sso-client",
        enterpriseManagedCredentials: {
          exchangeStrategy: "rfc8693",
          agentIdentity: { source: "spiffe" },
        },
      },
    });
    const leftOver = {
      identityProviderId: spiffeProvider.id,
      externalId: "agent-client-before-spiffe",
    };
    await AgentIdentityBindingModel.replaceForAgent({
      agentId,
      bindings: [leftOver],
    });

    const response = await replace(admin, agentId, [
      leftOver,
      { identityProviderId: oktaProviderId, externalId: "wlp-agent-1" },
    ]);

    expect(response.statusCode).toBe(200);
  });

  test("lets an admin correct the case of an identity", async () => {
    await AgentIdentityBindingModel.replaceForAgent({
      agentId,
      bindings: [
        { identityProviderId: oktaProviderId, externalId: "WLP-agent-1" },
      ],
    });

    const response = await replace(admin, agentId, [
      { identityProviderId: oktaProviderId, externalId: "wlp-agent-1" },
    ]);

    expect(response.json().bindings).toEqual([
      { identityProviderId: oktaProviderId, externalId: "wlp-agent-1" },
    ]);
  });

  test("refuses a provider of another organization", async ({
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const otherOrganization = await makeOrganization();
    const foreignProvider = await makeIdentityProvider(otherOrganization.id, {
      oidcConfig: {
        clientId: "sso-client",
        enterpriseManagedCredentials: { agentIdentity: {} },
      },
    });

    const response = await replace(admin, agentId, [
      { identityProviderId: foreignProvider.id, externalId: "wlp-agent-1" },
    ]);

    expect(response.statusCode).toBe(404);
  });

  // ===== Helpers =====

  type Binding = { identityProviderId: string; externalId: string };

  function replace(as: User, id: string, bindings: Binding[]) {
    return app.inject({
      method: "PUT",
      url: `/api/agents/${id}/identity-bindings`,
      headers: { [USER_HEADER]: as.id },
      payload: { bindings },
    });
  }

  function sortBindings(bindings: Binding[]): Binding[] {
    return [...bindings].sort((a, b) =>
      a.identityProviderId.localeCompare(b.identityProviderId),
    );
  }
});
