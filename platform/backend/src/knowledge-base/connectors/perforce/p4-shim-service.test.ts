// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { vi } from "vitest";
import logger from "@/logging";
import { KnowledgeBaseConnectorModel } from "@/models";
import SecretModel from "@/models/secret";
import { describe, expect, test } from "@/test";
import type { ConnectorConfig, ConnectorIdentity } from "@/types";
import {
  getP4ShimConnection,
  reconcileP4ShimForConnector,
} from "./p4-shim-service";

/**
 * The rotation fence: what `ensure()` consults before it writes. A permission
 * pass holds the connector's settings for its whole duration, so the shim
 * manager asks — at write time — whether those settings are still the
 * connector's own.
 */

/** The fence the manager is handed, alongside the fingerprint it guards. */
interface CapturedSpec {
  configIsCurrent: () => Promise<boolean>;
}

const ensure = vi.fn(async (_spec: CapturedSpec) => ({
  baseUrl: "http://p4-shim.test",
  authToken: "token",
}));
const apply = vi.fn(async (_spec: { connectorId: string }) => {});
const teardown = vi.fn(async (_scope: string) => {});

vi.mock("@/k8s/p4-shim-runtime/manager", () => ({
  p4ShimRuntimeManager: {
    isEnabled: () => true,
    // Referenced lazily: the factory is hoisted above `ensure`'s declaration.
    ensure: (spec: CapturedSpec) => ensure(spec),
    apply: (spec: { connectorId: string }) => apply(spec),
    teardown: (scope: string) => teardown(scope),
  },
}));

vi.mock("./p4-shim-client", () => ({
  P4ShimClient: class {
    async probe() {
      return { reachable: true, error: null };
    }
  },
}));

const perforceConfig: ConnectorConfig = {
  type: "perforce",
  serverUrl: "https://perforce.example.com:8080",
  depotPaths: ["//depot/docs"],
  adminUsername: "p4admin",
};

/** Whether the fence the manager was handed still accepts its fingerprint. */
async function fenceVerdict(): Promise<boolean> {
  const spec = ensure.mock.calls.at(-1)?.[0];
  if (!spec) throw new Error("the shim manager was never asked to reconcile");
  return spec.configIsCurrent();
}

async function connect(
  connector: { id: string; organizationId: string; secretId: string | null },
  overrides: { serverUrl?: string; username?: string } = {},
) {
  const identity: ConnectorIdentity = {
    connectorId: connector.id,
    organizationId: connector.organizationId,
    environmentId: null,
    secretId: connector.secretId,
    credentialVersion: await currentCredentialVersion(connector.secretId),
  };
  return getP4ShimConnection({
    identity,
    serverUrl: overrides.serverUrl ?? "https://perforce.example.com:8080",
    username: overrides.username ?? "p4admin",
    password: "secret",
    log: logger,
  });
}

async function currentCredentialVersion(
  secretId: string | null,
): Promise<string> {
  if (!secretId) return "";
  const secret = await SecretModel.findById(secretId);
  return secret?.updatedAt?.toISOString() ?? "";
}

async function makeConnector(organizationId: string, secretId?: string) {
  return KnowledgeBaseConnectorModel.create({
    organizationId,
    name: `Perforce ${crypto.randomUUID().slice(0, 8)}`,
    connectorType: "perforce",
    config: perforceConfig,
    visibility: "auto-sync-permissions",
    ...(secretId ? { secretId } : {}),
  });
}

describe("p4 shim rotation fence", () => {
  test("accepts a pass whose settings are still the connector's own", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);

    await connect(connector);

    expect(await fenceVerdict()).toBe(true);
  });

  test("refuses a pass holding the server URL an edit replaced", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    await connect(connector);

    await KnowledgeBaseConnectorModel.update(connector.id, {
      config: {
        ...perforceConfig,
        serverUrl: "https://moved.example.com:8080",
      },
    });

    // Reconciling now would roll the pod back onto the old server and re-open
    // egress to it.
    expect(await fenceVerdict()).toBe(false);
  });

  test("refuses a pass holding the admin user an edit replaced", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    await connect(connector);

    await KnowledgeBaseConnectorModel.update(connector.id, {
      config: { ...perforceConfig, adminUsername: "someone-else" },
    });

    expect(await fenceVerdict()).toBe(false);
  });

  test("refuses a pass holding the credentials a rotation replaced", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secret = await SecretModel.create({
      name: `connector-${crypto.randomUUID().slice(0, 8)}`,
      secret: { apiToken: "t", adminApiKey: "old-password" },
    });
    const connector = await makeConnector(org.id, secret.id);
    await connect(connector);
    expect(await fenceVerdict()).toBe(true);

    await SecretModel.update(secret.id, {
      secret: { apiToken: "t", adminApiKey: "new-password" },
    });

    // The fingerprint carries the secret's version, never its value, so a
    // rotation retires the pod without a password reaching an annotation.
    expect(await fenceVerdict()).toBe(false);
  });

  test("refuses a pass whose connector has been deleted", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    await connect(connector);

    await KnowledgeBaseConnectorModel.delete(connector.id);

    expect(await fenceVerdict()).toBe(false);
  });

  test("a settings change that cannot reach the shim leaves it alone", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    await connect(connector);

    // Renaming the connector changes nothing the pod's behaviour or reach
    // depends on, so the running pass keeps its shim rather than paying for a
    // pod roll.
    await KnowledgeBaseConnectorModel.update(connector.id, {
      name: "Renamed",
    });

    expect(await fenceVerdict()).toBe(true);
  });
});

/**
 * The lifecycle rule: whether a connector has a shim at all is a function of
 * its row, evaluated on every write that could change the answer. Nothing here
 * consults the cluster, a clock, or when a pass last ran.
 */
describe("reconcileP4ShimForConnector", () => {
  test("gives a Perforce connector that syncs permissions a running shim", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);

    await reconcileP4ShimForConnector(connector.id);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].connectorId).toBe(connector.id);
    expect(teardown).not.toHaveBeenCalled();
  });

  test("removes the shim when the connector is disabled", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    await KnowledgeBaseConnectorModel.update(connector.id, { enabled: false });

    await reconcileP4ShimForConnector(connector.id);

    // A disabled connector runs no pass, so its pod would sit holding a bearer
    // token and an open route to the customer's Perforce server for nothing.
    expect(teardown).toHaveBeenCalledWith(connector.id);
    expect(apply).not.toHaveBeenCalled();
  });

  test("removes the shim when the connector stops syncing permissions", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    await KnowledgeBaseConnectorModel.update(connector.id, {
      visibility: "org-wide",
    });

    await reconcileP4ShimForConnector(connector.id);

    expect(teardown).toHaveBeenCalledWith(connector.id);
  });

  test("removes the shim when the connector is deleted", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    await KnowledgeBaseConnectorModel.delete(connector.id);

    await reconcileP4ShimForConnector(connector.id);

    expect(teardown).toHaveBeenCalledWith(connector.id);
  });

  test("removes the shim when the connector has no admin user to run as", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    await KnowledgeBaseConnectorModel.update(connector.id, {
      config: { ...perforceConfig, adminUsername: undefined },
    });

    await reconcileP4ShimForConnector(connector.id);

    expect(teardown).toHaveBeenCalledWith(connector.id);
  });

  test("removes the shim when the settings no longer name a server", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    await KnowledgeBaseConnectorModel.update(connector.id, {
      // A wire-address override that does not parse. The connector row is
      // written by more than the form that validates it — MCP tools, restores,
      // hand-edited rows — so the reconcile has to answer for a config it
      // cannot build a pod from.
      config: { ...perforceConfig, p4Port: "not-an-address" },
    });

    await reconcileP4ShimForConnector(connector.id);

    // There is no server to scope the pod's egress to, and a pod that cannot
    // be given one is a token and a policy with nothing behind them.
    expect(teardown).toHaveBeenCalledWith(connector.id);
  });

  test("leaves the cluster alone for a connector that is not Perforce", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await KnowledgeBaseConnectorModel.create({
      organizationId: org.id,
      name: "Web",
      connectorType: "web_crawler",
      config: { type: "web_crawler", startUrl: "https://example.com" },
      visibility: "org-wide",
    });

    await reconcileP4ShimForConnector(connector.id);

    // This runs on every connector edit in the deployment; a connector that
    // never had a shim must not cost four 404ing deletes each time.
    expect(teardown).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  test("never throws: the row is already committed by the time it runs", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const connector = await makeConnector(org.id);
    apply.mockRejectedValueOnce(new Error("the API server is unreachable"));

    await expect(
      reconcileP4ShimForConnector(connector.id),
    ).resolves.toBeUndefined();
  });
});
