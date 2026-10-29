import { vi } from "vitest";

// The Kubernetes runtime is the process boundary here: what pods run and the
// rollout itself. Everything between (catalog/install rows, the cluster lease,
// the refresh path) runs for real.
vi.mock("@/k8s/mcp-server-runtime", () => ({
  McpServerRuntimeManager: {
    isEnabled: true,
    readRunningImage: vi.fn(),
    readImagePullSecretConfigs: vi.fn(async () => []),
    restartServer: vi.fn(),
    getOrLoadDeployment: vi.fn(async () => undefined),
    reinstallSharedDeployment: vi.fn(),
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    ensureAwake: vi.fn(),
    isDeploymentDormant: vi.fn(() => false),
    registerHibernationListener: vi.fn(),
    // SPDX-SnippetEnd
  },
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  McpServerWakeError: class McpServerWakeError extends Error {},
  // SPDX-SnippetEnd
}));

vi.mock("@/websocket", () => ({
  broadcastMcpInstallationStatus: vi.fn(),
}));

import { HttpResponse, http } from "msw";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import { McpServerModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { mcpImageUpdateChecker } from "./mcp-image-update-checker";

const RUNNING_DIGEST = `sha256:${"1".repeat(64)}`;
const NEW_DIGEST = `sha256:${"2".repeat(64)}`;
const REGISTRY = "registry.example.com";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();

describe("mcpImageUpdateChecker.checkAll", () => {
  let registryHeads: string[];

  beforeEach(() => {
    vi.resetAllMocks();
    registryHeads = [];
    vi.spyOn(McpServerModel, "getToolsFromServer").mockResolvedValue([]);
  });

  test("rolls out an install whose mutable tag now points at a new image", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    const { install } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      image: `${REGISTRY}/acme/moving:latest`,
    });
    serveRegistryDigest("acme/moving", NEW_DIGEST);
    runningImage(`${REGISTRY}/acme/moving:latest`);

    await mcpImageUpdateChecker.checkAll();

    expect(McpServerRuntimeManager.restartServer).toHaveBeenCalledTimes(1);
    expect(McpServerRuntimeManager.restartServer).toHaveBeenCalledWith(
      install.id,
      { freshImagePull: true },
    );
  });

  // A registry whose digest never matches what the pod records (e.g. a
  // per-platform digest) must not turn into a restart every sweep.
  test("rolls out a given registry digest only once", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      image: `${REGISTRY}/acme/mismatch:latest`,
    });
    serveRegistryDigest("acme/mismatch", NEW_DIGEST);
    runningImage(`${REGISTRY}/acme/mismatch:latest`);

    await mcpImageUpdateChecker.checkAll();
    // The pod comes back still reporting the old digest.
    await mcpImageUpdateChecker.checkAll();

    expect(McpServerRuntimeManager.restartServer).toHaveBeenCalledTimes(1);
  });

  test("leaves an install alone when the registry still serves the running digest", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      image: `${REGISTRY}/acme/steady`,
    });
    serveRegistryDigest("acme/steady", RUNNING_DIGEST);
    runningImage(`${REGISTRY}/acme/steady`);

    await mcpImageUpdateChecker.checkAll();

    expect(registryHeads).toEqual(["acme/steady"]);
    expect(McpServerRuntimeManager.restartServer).not.toHaveBeenCalled();
  });

  test("never queries the registry for a pinned tag or digest", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      image: `${REGISTRY}/acme/pinned:1.2.3`,
    });
    await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      image: `${REGISTRY}/acme/pinned@${RUNNING_DIGEST}`,
    });

    await mcpImageUpdateChecker.checkAll();

    expect(McpServerRuntimeManager.readRunningImage).not.toHaveBeenCalled();
    expect(registryHeads).toEqual([]);
    expect(McpServerRuntimeManager.restartServer).not.toHaveBeenCalled();
  });

  test("skips a hibernated install without reading its pods or the registry", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      image: `${REGISTRY}/acme/sleepy:latest`,
    });
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    vi.mocked(McpServerRuntimeManager.isDeploymentDormant).mockReturnValue(
      true,
    );
    // SPDX-SnippetEnd

    await mcpImageUpdateChecker.checkAll();

    expect(McpServerRuntimeManager.readRunningImage).not.toHaveBeenCalled();
    expect(registryHeads).toEqual([]);
    expect(McpServerRuntimeManager.restartServer).not.toHaveBeenCalled();
  });

  test("a registry failure skips that catalog and the sweep carries on", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      image: `${REGISTRY}/acme/broken:latest`,
    });
    const { install: healthy } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      image: `${REGISTRY}/acme/healthy:latest`,
    });
    server.use(
      http.head(
        `https://${REGISTRY}/v2/acme/broken/manifests/latest`,
        () => new HttpResponse(null, { status: 429 }),
      ),
    );
    serveRegistryDigest("acme/healthy", NEW_DIGEST);
    vi.mocked(McpServerRuntimeManager.readRunningImage).mockImplementation(
      async (mcpServerId) => {
        const install = await McpServerModel.findById(mcpServerId);
        const image =
          install?.catalogId === healthy.catalogId ? "healthy" : "broken";
        return runningImageOf(`${REGISTRY}/acme/${image}:latest`);
      },
    );

    await expect(mcpImageUpdateChecker.checkAll()).resolves.toBeUndefined();

    expect(McpServerRuntimeManager.restartServer).toHaveBeenCalledTimes(1);
    expect(McpServerRuntimeManager.restartServer).toHaveBeenCalledWith(
      healthy.id,
      { freshImagePull: true },
    );
  });

  test("a multi-tenant catalog is checked and recreated once, not per install", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    const { catalog } = await makeLocalInstall({
      makeInternalMcpCatalog,
      makeMcpServer,
      makeUser,
      image: `${REGISTRY}/acme/shared:latest`,
      multitenant: true,
    });
    await makeMcpServer({ catalogId: catalog.id, name: "second-tenant" });
    serveRegistryDigest("acme/shared", NEW_DIGEST);
    runningImage(`${REGISTRY}/acme/shared:latest`);

    await mcpImageUpdateChecker.checkAll();

    expect(McpServerRuntimeManager.readRunningImage).toHaveBeenCalledTimes(1);
    expect(registryHeads).toEqual(["acme/shared"]);
    expect(
      McpServerRuntimeManager.reinstallSharedDeployment,
    ).toHaveBeenCalledTimes(1);
    expect(
      McpServerRuntimeManager.reinstallSharedDeployment,
    ).toHaveBeenCalledWith(catalog.id, { freshImagePull: true });
    expect(McpServerRuntimeManager.restartServer).not.toHaveBeenCalled();
  });

  // ===
  // Helpers
  // ===

  function serveRegistryDigest(repository: string, digest: string) {
    server.use(
      http.head(`https://${REGISTRY}/v2/${repository}/manifests/latest`, () => {
        registryHeads.push(repository);
        return new HttpResponse(null, {
          headers: { "Docker-Content-Digest": digest },
        });
      }),
    );
  }

  function runningImage(image: string) {
    vi.mocked(McpServerRuntimeManager.readRunningImage).mockResolvedValue(
      runningImageOf(image),
    );
  }
});

function runningImageOf(image: string) {
  return {
    image,
    digest: RUNNING_DIGEST,
    pullPolicy: "Always",
    pullSecretNames: [],
  };
}

async function makeLocalInstall(params: {
  makeInternalMcpCatalog: (
    overrides: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  makeMcpServer: (overrides: {
    catalogId: string;
    name?: string;
    ownerId?: string;
  }) => Promise<{ id: string; catalogId: string | null }>;
  makeUser: () => Promise<{ id: string }>;
  image: string;
  multitenant?: boolean;
}) {
  const catalog = await params.makeInternalMcpCatalog({
    serverType: "local",
    serverUrl: null,
    multitenant: params.multitenant ?? false,
    localConfig: {
      dockerImage: params.image,
      transportType: "stdio",
      environment: [],
    },
  });
  const owner = await params.makeUser();
  const install = await params.makeMcpServer({
    catalogId: catalog.id,
    ownerId: owner.id,
  });
  return { catalog, install };
}
