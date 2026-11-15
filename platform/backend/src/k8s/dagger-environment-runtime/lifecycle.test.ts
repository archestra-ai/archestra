import { KubeConfig } from "@kubernetes/client-node";
import { HttpResponse, type HttpResponseResolver, http } from "msw";
import { beforeEach, describe, expect, vi } from "vitest";
import config from "@/config";
import { AuditLogModel, EnvironmentModel } from "@/models";
import { test } from "@/test";
import { useMswServer } from "@/test/msw";
import { daggerEnvironmentRuntimeManager as manager } from "./manager";

vi.mock("@/k8s/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/k8s/shared")>();
  return {
    ...actual,
    isK8sConfigured: () => true,
    getK8sNamespace: () => "release",
    loadKubeConfig: () => {
      const kubeConfig = new KubeConfig();
      kubeConfig.loadFromOptions({
        clusters: [{ name: "test", server: "https://k8s.test" }],
        users: [{ name: "test" }],
        contexts: [{ name: "test", cluster: "test", user: "test" }],
        currentContext: "test",
      });
      return { kubeConfig, namespace: "release" };
    },
  };
});

// A small API server boundary: the real Kubernetes client serializes requests
// and handles errors. No model or client methods are replaced.
type Resource = {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    uid?: string;
    deletionTimestamp?: string;
    annotations?: Record<string, string>;
  };
  spec?: {
    volumeClaimTemplates?: Array<{
      metadata?: { labels?: Record<string, string> };
    }>;
    template?: {
      metadata?: { annotations?: Record<string, string> };
      spec?: { containers?: Array<{ image?: string }> };
    };
  };
};
// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper.
const server = useMswServer();
let resources: Map<string, Resource>;
let pauseCreate: (() => Promise<void>) | undefined;
let pvcDeleteFailures: number;
let holdWorkloadDeletion: boolean;
let failListings: boolean;
let policyDeleteFailures: number;
let onWorkloadRead: (() => void) | undefined;
let statefulSetUpdates: number;
let statefulSetUpdateStatus: number | undefined;
const key = (ns: string, collection: string, name: string) =>
  `${ns}/${collection}/${name}`;
const absent = () =>
  HttpResponse.json({ kind: "Status", code: 404 }, { status: 404 });

beforeEach(() => {
  resources = new Map();
  pauseCreate = undefined;
  pvcDeleteFailures = 0;
  holdWorkloadDeletion = false;
  failListings = false;
  policyDeleteFailures = 0;
  onWorkloadRead = undefined;
  statefulSetUpdates = 0;
  statefulSetUpdateStatus = undefined;
  config.skillsSandbox.enabled = true;
  config.daggerRuntime.engine.nodeSelector = { pool: "test" };
  config.orchestrator.kubernetes.environmentNamespaces = [
    "release",
    "env-test",
  ];
  config.orchestrator.kubernetes.runtimeOwnerRoleName = "runtime-owner";
  const handler: HttpResponseResolver = async ({ request }) => {
    const match = new URL(request.url).pathname.match(
      /\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/,
    );
    if (!match) return absent();
    const [, ns, collection, name] = match;
    if (collection === "roles" && name === "runtime-owner") {
      return HttpResponse.json({ metadata: { name, uid: "our-owner-uid" } });
    }
    if (request.method === "GET") {
      if (collection === "statefulsets" && holdWorkloadDeletion)
        onWorkloadRead?.();
      if (name)
        return resources.has(key(ns, collection, name))
          ? HttpResponse.json(resources.get(key(ns, collection, name)))
          : absent();
      if (failListings)
        return HttpResponse.json({ code: 503 }, { status: 503 });
      return HttpResponse.json({
        items: [...resources.entries()]
          .filter(([id]) => id.startsWith(`${ns}/${collection}/`))
          .map(([, body]) => body),
      });
    }
    if (request.method === "POST") {
      const body = (await request.json()) as Resource;
      if (collection === "statefulsets") await pauseCreate?.();
      const id = key(ns, collection, body.metadata.name);
      if (resources.has(id))
        return HttpResponse.json({ code: 409 }, { status: 409 });
      resources.set(id, body);
      if (collection === "statefulsets") {
        const pvcName = `varlib-${body.metadata.name}-0`;
        resources.set(key(ns, "persistentvolumeclaims", pvcName), {
          metadata: {
            name: pvcName,
            namespace: ns,
            labels: body.spec?.volumeClaimTemplates?.[0].metadata?.labels,
          },
        });
      }
      return HttpResponse.json(body, { status: 201 });
    }
    if (request.method === "DELETE") {
      if (collection === "networkpolicies" && policyDeleteFailures-- > 0) {
        return HttpResponse.json({ code: 503 }, { status: 503 });
      }
      if (
        collection === "statefulsets" &&
        holdWorkloadDeletion &&
        resources.has(key(ns, collection, name))
      ) {
        expect(new URL(request.url).searchParams.get("propagationPolicy")).toBe(
          "Foreground",
        );
        return HttpResponse.json({ kind: "Status", status: "Success" });
      }
      if (collection === "persistentvolumeclaims" && pvcDeleteFailures-- > 0) {
        return HttpResponse.json({ code: 403 }, { status: 403 });
      }
      return resources.delete(key(ns, collection, name))
        ? HttpResponse.json({ kind: "Status", status: "Success" })
        : absent();
    }
    if (request.method === "PUT") {
      if (collection === "statefulsets") {
        statefulSetUpdates++;
        if (statefulSetUpdateStatus)
          return HttpResponse.json(
            { code: statefulSetUpdateStatus },
            { status: statefulSetUpdateStatus },
          );
      }
      const body = (await request.json()) as Resource;
      resources.set(key(ns, collection, name), body);
      return HttpResponse.json(body);
    }
    return absent();
  };
  const roots = [
    "api/v1",
    "apis/apps/v1",
    "apis/networking.k8s.io/v1",
    "apis/rbac.authorization.k8s.io/v1",
    "apis/cilium.io/v2",
    "apis/networking.gke.io/v1alpha1",
    "apis/networking.k8s.aws/v1alpha1",
  ];
  server.use(
    http.get("https://k8s.test/apis/:group/:version", absent),
    ...roots
      .flatMap((root) => [
        `https://k8s.test/${root}/namespaces/:namespace/:collection`,
        `https://k8s.test/${root}/namespaces/:namespace/:collection/:name`,
      ])
      .map((path) => http.all(path, handler)),
  );
});

describe("Dagger environment lifecycle", () => {
  test("a deleted environment snapshot cannot recreate an engine", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Disposable",
      namespace: "env-test",
    });
    await EnvironmentModel.delete(env.id, org.id);
    await manager.reconcileEnvironment(env);
    expect([...resources.keys()]).toEqual([]);
  });

  test("deletion wins when an already-started reconcile creates after teardown", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Concurrent",
      namespace: "env-test",
    });
    let signalReached!: () => void;
    let signalRelease!: () => void;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });
    pauseCreate = async () => {
      signalReached();
      await release;
    };
    const reconcile = manager.reconcileEnvironment(env);
    await Promise.race([reached, reconcile]);
    await EnvironmentModel.delete(env.id, org.id);
    await manager.teardownEnvironmentEngine(env);
    signalRelease();
    await reconcile;
    expect([...resources.keys()]).toEqual([]);
  });

  test("repairs a legacy zombie engine and disk using this database's deletion audit", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Legacy",
      namespace: "env-test",
    });
    await manager.reconcileEnvironment(env);
    for (const resource of resources.values()) {
      delete resource.metadata.labels?.["archestra.io/dagger-runtime-owner"];
      delete resource.metadata.labels?.["archestra.io/dagger-organization"];
    }
    await recordDeletion(env);
    await EnvironmentModel.delete(env.id, org.id);
    await manager.reconcileAll();
    expect(engineResources(env.id)).toEqual([]);
    // The org default has no Environment row; it must survive every sweep.
    const defaultId = manager.organizationDefaultTarget(org)?.environmentId;
    expect(defaultId).toBeDefined();
    expect(engineResources(defaultId ?? "").length).toBeGreaterThan(0);
  });

  test("repairs a legacy disk whose StatefulSet and ConfigMap are already gone", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Retained cache",
      namespace: "env-test",
    });
    const name = `varlib-dagger-engine-${env.id}-0`;
    resources.set(key("env-test", "persistentvolumeclaims", name), {
      metadata: { name },
    });
    await recordDeletion(env);
    await EnvironmentModel.delete(env.id, org.id);
    await manager.reconcileAll();
    expect(engineResources(env.id)).toEqual([]);
  });

  test("retries a failed cache delete after the Environment row is gone", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Retry",
      namespace: "env-test",
    });
    await manager.reconcileEnvironment(env);
    await EnvironmentModel.delete(env.id, org.id);
    pvcDeleteFailures = 1;
    await manager.teardownEnvironmentEngine(env);
    expect(engineResources(env.id)).toHaveLength(3);
    await manager.reconcileAll();
    expect(engineResources(env.id)).toEqual([]);
  });

  test("repairs owned engines without a Helm runtime-owner Role or audit history", async ({
    makeOrganization,
  }) => {
    config.orchestrator.kubernetes.runtimeOwnerRoleName = undefined;
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Standalone install",
      namespace: "env-test",
    });
    await manager.reconcileEnvironment(env);
    await EnvironmentModel.delete(env.id, org.id);
    await manager.reconcileAll();
    expect(engineResources(env.id)).toEqual([]);
  });

  test("preserves config, storage and egress until foreground workload deletion finishes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Terminating",
      namespace: "env-test",
    });
    await manager.reconcileEnvironment(env);
    const before = engineResources(env.id);
    await EnvironmentModel.delete(env.id, org.id);
    holdWorkloadDeletion = true;
    let signalRead!: () => void;
    const workloadRead = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    onWorkloadRead = signalRead;
    const teardown = manager.teardownEnvironmentEngine(env);
    await Promise.race([workloadRead, teardown]);
    expect(engineResources(env.id)).toEqual(before);
    resources.delete(
      key("env-test", "statefulsets", `dagger-engine-${env.id}`),
    );
    holdWorkloadDeletion = false;
    await teardown;
    expect(engineResources(env.id)).toEqual([]);
  });

  test("keeps a retry marker when a policy deletion fails", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Policy retry",
      namespace: "env-test",
    });
    await manager.reconcileEnvironment(env);
    await EnvironmentModel.delete(env.id, org.id);
    policyDeleteFailures = 1;
    await manager.teardownEnvironmentEngine(env);
    expect(engineResources(env.id)).toHaveLength(2);
    await manager.reconcileAll();
    expect(engineResources(env.id)).toEqual([]);
  });

  test("a shared runtime-owner Role does not authorize pruning another installation's organization", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Shared owner",
      namespace: "env-test",
    });
    await manager.reconcileEnvironment(env);
    await recordDeletion(env);
    await EnvironmentModel.delete(env.id, org.id);
    for (const resource of resources.values()) {
      resource.metadata.labels = {
        ...resource.metadata.labels,
        "archestra.io/dagger-organization": "another-installation-organization",
      };
    }
    const before = engineResources(env.id);
    await manager.reconcileAll();
    expect(engineResources(env.id)).toEqual(before);
  });

  test("legacy ownership evidence must name the resource's namespace", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Scoped history",
      namespace: "env-test",
    });
    const name = `varlib-dagger-engine-${env.id}-0`;
    // Same-shaped legacy identity in a different namespace has no proof of ownership.
    resources.set(key("release", "persistentvolumeclaims", name), {
      metadata: { name },
    });
    await recordDeletion(env);
    await EnvironmentModel.delete(env.id, org.id);
    await manager.reconcileAll();
    expect(engineResources(env.id)).toHaveLength(1);
  });

  test("preserves live engines, foreign owners, and unproven legacy claims", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const live = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Live",
      namespace: "env-test",
    });
    await manager.reconcileEnvironment(live);
    const foreign = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Foreign",
      namespace: "env-test",
    });
    await manager.reconcileEnvironment(foreign);
    await recordDeletion(foreign);
    await EnvironmentModel.delete(foreign.id, org.id);
    for (const resource of resources.values()) {
      if (resource.metadata.name.includes(foreign.id)) {
        resource.metadata.labels = {
          ...resource.metadata.labels,
          "archestra.io/dagger-runtime-owner": "another-release-uid",
        };
      }
    }
    const unknown = "00000000-0000-4000-8000-000000000123";
    const name = `varlib-dagger-engine-${unknown}-0`;
    resources.set(key("env-test", "persistentvolumeclaims", name), {
      metadata: { name },
    });
    const beforeForeign = engineResources(foreign.id);
    await manager.reconcileAll();
    expect(engineResources(live.id).length).toBeGreaterThan(0);
    expect(engineResources(foreign.id)).toEqual(beforeForeign);
    expect(engineResources(unknown)).toHaveLength(1);
  });

  test("a failed inventory read never becomes permission to delete", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Unavailable API",
      namespace: "env-test",
    });
    await manager.reconcileEnvironment(env);
    await EnvironmentModel.delete(env.id, org.id);
    const before = engineResources(env.id);
    failListings = true;
    await manager.reconcileAll();
    expect(engineResources(env.id)).toEqual(before);
  });
});

describe("Dagger engine updates", () => {
  const original = {
    version: config.api.version,
    image: config.daggerRuntime.engine.image,
    memoryLimit: config.daggerRuntime.engine.memoryLimit,
  };
  beforeEach(() => {
    config.api.version = "v1.6.0";
    config.daggerRuntime.engine.image = "registry.example/engine:new";
    return () => {
      config.api.version = original.version;
      config.daggerRuntime.engine.image = original.image;
      config.daggerRuntime.engine.memoryLimit = original.memoryLimit;
    };
  });

  async function provisioned(makeOrganization: () => Promise<{ id: string }>) {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Updates",
      namespace: "env-test",
    });
    await manager.reconcileEnvironment(env);
    const id = engineResources(env.id).find((resource) =>
      resource.includes("/statefulsets/"),
    );
    if (!id) throw new Error("engine was not created");
    return {
      env,
      read: () => resources.get(id) as Resource,
      write: (body: Resource) => resources.set(id, body),
    };
  }

  test("moves an engine created by an earlier release to the current spec and keeps its cache", async ({
    makeOrganization,
  }) => {
    const { env, read, write } = await provisioned(makeOrganization);
    const created = structuredClone(read());
    // What an earlier release left behind: its own image, and no spec hash or
    // platform version.
    const legacy = structuredClone(created);
    delete legacy.metadata.annotations;
    delete legacy.spec?.template?.metadata?.annotations;
    const [container] = legacy.spec?.template?.spec?.containers ?? [];
    container.image = "registry.example/engine:old";
    write(legacy);

    await manager.reconcileEnvironment(env);

    expect(statefulSetUpdates).toBe(1);
    const updated = read();
    expect(updated.spec?.template?.spec?.containers?.[0].image).toBe(
      "registry.example/engine:new",
    );
    expect(updated.spec?.template).toEqual(created.spec?.template);
    expect(updated.metadata.annotations).toMatchObject({
      "archestra.io/dagger-engine-platform-version": "v1.6.0",
    });
    // The cache claim is immutable and stays as the engine was created.
    expect(updated.spec?.volumeClaimTemplates).toEqual(
      legacy.spec?.volumeClaimTemplates,
    );
    expect(
      engineResources(env.id).some((id) =>
        id.includes("/persistentvolumeclaims/"),
      ),
    ).toBe(true);
  });

  test("leaves an engine already on the current spec untouched", async ({
    makeOrganization,
  }) => {
    const { env, read } = await provisioned(makeOrganization);
    const before = structuredClone(read());

    await manager.reconcileEnvironment(env);
    await manager.reconcileEnvironment(env);

    expect(statefulSetUpdates).toBe(0);
    expect(read()).toEqual(before);
  });

  test("restarts the engine when only its resources change", async ({
    makeOrganization,
  }) => {
    const { env, read } = await provisioned(makeOrganization);
    const before = read().spec?.template?.metadata?.annotations;
    config.daggerRuntime.engine.memoryLimit = "7Gi";

    await manager.reconcileEnvironment(env);

    expect(statefulSetUpdates).toBe(1);
    expect(read().spec?.template?.metadata?.annotations).not.toEqual(before);
  });

  test("an older platform never moves back an engine a newer one updated", async ({
    makeOrganization,
  }) => {
    const { env, read } = await provisioned(makeOrganization);
    const image = () => read().spec?.template?.spec?.containers?.[0].image;
    for (const version of ["v1.5.9", "v1.6.0-rc.12"]) {
      config.api.version = version;
      config.daggerRuntime.engine.image = "registry.example/engine:older";
      await manager.reconcileEnvironment(env);
    }
    expect(statefulSetUpdates).toBe(0);
    expect(image()).toBe("registry.example/engine:new");

    // A newer prerelease moves it, and rc.10 sorts after rc.9.
    config.api.version = "v1.6.1-rc.10";
    config.daggerRuntime.engine.image = "registry.example/engine:newer";
    await manager.reconcileEnvironment(env);
    expect(image()).toBe("registry.example/engine:newer");
    config.api.version = "v1.6.1-rc.9";
    config.daggerRuntime.engine.image = "registry.example/engine:older";
    await manager.reconcileEnvironment(env);
    expect(image()).toBe("registry.example/engine:newer");
  });

  test("a failed or conflicting update still applies the engine's egress policy", async ({
    makeOrganization,
  }) => {
    const { env } = await provisioned(makeOrganization);
    for (const status of [409, 500]) {
      for (const id of engineResources(env.id).filter((resource) =>
        resource.includes("/networkpolicies/"),
      ))
        resources.delete(id);
      config.daggerRuntime.engine.image = `registry.example/engine:${status}`;
      statefulSetUpdateStatus = status;

      await manager.reconcileEnvironment(env);

      expect(
        engineResources(env.id).some((id) => id.includes("/networkpolicies/")),
      ).toBe(true);
    }
    expect(statefulSetUpdates).toBe(2);
  });
});

function engineResources(id: string) {
  return [...resources.keys()]
    .filter((resource) => resource.includes(id))
    .sort();
}

async function recordDeletion(env: {
  id: string;
  organizationId: string;
  namespace: string | null;
}) {
  await AuditLogModel.create({
    organizationId: env.organizationId,
    actorType: "user",
    action: "environment.deleted",
    outcome: "success",
    occurredAt: new Date(),
    resourceType: "environment",
    resourceId: env.id,
    before: { id: env.id, namespace: env.namespace },
  });
}
