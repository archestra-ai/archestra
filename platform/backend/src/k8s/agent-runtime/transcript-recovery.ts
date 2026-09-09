import { randomUUID } from "node:crypto";
import type {
  CoreV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
} from "@kubernetes/client-node";
import { isK8sNotFoundError } from "@/k8s/shared";
import type { AgentRunRecord } from "@/types";
import {
  AGENT_RUNTIME_CONTAINER_NAME,
  AGENT_SANDBOX_API,
  type AgentSandbox,
} from "./manifests";

/** Read retained output without resuming the workspace or extending its deadline. */
export async function withTranscriptRecoveryPod(params: {
  clients: {
    coreApi: CoreV1Api;
    customObjectsApi: CustomObjectsApi;
    networkingApi: NetworkingV1Api;
  };
  session: AgentRunRecord;
  read: (podName: string) => Promise<void>;
  abortSignal?: AbortSignal;
}): Promise<void> {
  params.abortSignal?.throwIfAborted();
  const { clients, session } = params;
  const namespace = session.runtimeScope;
  const sandbox = (await clients.customObjectsApi.getNamespacedCustomObject({
    ...AGENT_SANDBOX_API,
    namespace,
    name: session.workloadName,
  })) as AgentSandbox;
  const template = sandbox.spec.podTemplate.spec;
  const image = template?.containers.find(
    (container) => container.name === AGENT_RUNTIME_CONTAINER_NAME,
  )?.image;
  if (!sandbox.metadata.uid || !image)
    throw new Error("Workspace recovery metadata is unavailable");
  const claim = await clients.coreApi.readNamespacedPersistentVolumeClaim({
    namespace,
    name: `workspace-${session.workloadName}`,
  });
  if (
    !claim.metadata?.name ||
    !claim.metadata.ownerReferences?.some(
      (owner) => owner.uid === sandbox.metadata.uid,
    )
  ) {
    throw new Error(
      "Workspace recovery storage does not belong to this Sandbox",
    );
  }
  const name = `agent-transcript-${randomUUID()}`;
  const labels = { "archestra.io/transcript-recovery": name };
  const ownerReferences = [
    {
      apiVersion: sandbox.apiVersion,
      kind: sandbox.kind,
      name: session.workloadName,
      uid: sandbox.metadata.uid,
    },
  ];
  const metadata = { name, namespace, labels, ownerReferences };
  // Install isolation before scheduling. Deliberately omit workspace/agent labels
  // so the agent's platform and environment allow policies do not select this Pod.
  await clients.networkingApi.createNamespacedNetworkPolicy({
    namespace,
    body: {
      metadata,
      spec: {
        podSelector: { matchLabels: labels },
        policyTypes: ["Ingress", "Egress"],
        ingress: [],
        egress: [],
      },
    },
  });
  try {
    await clients.coreApi.createNamespacedPod({
      namespace,
      body: {
        metadata,
        spec: {
          restartPolicy: "Never",
          activeDeadlineSeconds: 120,
          terminationGracePeriodSeconds: 0,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          nodeSelector: template?.nodeSelector,
          tolerations: template?.tolerations,
          imagePullSecrets: template?.imagePullSecrets,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: AGENT_RUNTIME_CONTAINER_NAME,
              image,
              command: ["/bin/sh", "-c", "sleep 120"],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: { cpu: "10m", memory: "32Mi" },
                limits: { cpu: "100m", memory: "128Mi" },
              },
              volumeMounts: [
                {
                  name: "runtime",
                  mountPath: "/var/run/archestra",
                  subPath: "runtime",
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: "runtime",
              persistentVolumeClaim: {
                claimName: claim.metadata.name,
                readOnly: true,
              },
            },
          ],
        },
      },
    });
    const deadline = Date.now() + 60_000;
    while (true) {
      params.abortSignal?.throwIfAborted();
      const pod = await clients.coreApi.readNamespacedPod({ namespace, name });
      if (pod.status?.phase === "Running") break;
      if (
        pod.status?.phase === "Failed" ||
        pod.status?.phase === "Succeeded" ||
        Date.now() >= deadline
      ) {
        throw new Error("Transcript recovery Pod did not become ready");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await params.read(name);
  } finally {
    // Keep the deny policy until Pod deletion is accepted. Owner references also
    // remove both objects with the Sandbox after a process crash.
    await clients.coreApi
      .deleteNamespacedPod({ namespace, name, gracePeriodSeconds: 0 })
      .catch(ignoreNotFound);
    await clients.networkingApi
      .deleteNamespacedNetworkPolicy({ namespace, name })
      .catch(ignoreNotFound);
  }
}

function ignoreNotFound(error: unknown): void {
  if (!isK8sNotFoundError(error)) throw error;
}
