---
title: Agent Runtime Setup
sidebarTitle: Setup
description: Prepare Kubernetes nodes, storage, and the Agent Sandbox controller for Agent Runtime
order: 1
lastUpdated: 2026-10-08
beta: "Needs Kubernetes, persistent storage, and the [Agent Sandbox controller](https://agent-sandbox.sigs.k8s.io/docs/)."
---

Prepare your cluster once, and every agent can get a dedicated runtime. Each run becomes a pod with its own persistent volume, created by the [Agent Sandbox controller](https://agent-sandbox.sigs.k8s.io/docs/).

You install three things:

- **The controller** and its custom resources.
- **A storage class** with dynamic volume provisioning.
- **Archestra's access** to the cluster.

## Cluster Prerequisites

Your cluster needs Linux nodes compatible with the runtime images, a storage class with dynamic volume provisioning, and the Helm chart's runtime permissions in every execution namespace. Allow outbound access to the image registry, DNS, and Archestra's API, proxy, and gateway.

The quickstart Docker image installs the controller in its KinD cluster. On other clusters, install the tested version of the controller and its extensions:

```bash
kubectl apply --server-side -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.1/sandbox-with-extensions.yaml
kubectl wait --for=condition=Established \
  crd/sandboxes.agents.x-k8s.io \
  crd/sandboxtemplates.extensions.agents.x-k8s.io \
  crd/sandboxwarmpools.extensions.agents.x-k8s.io \
  crd/sandboxclaims.extensions.agents.x-k8s.io --timeout=60s
kubectl create configmap agent-sandbox-config -n agent-sandbox-system \
  --from-literal=allowed-label-domains=sandbox.users.io,archestra.io \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/agent-sandbox-controller -n agent-sandbox-system
kubectl rollout status deployment/agent-sandbox-controller -n agent-sandbox-system --timeout=120s
```

Give Archestra access to the cluster. When Archestra runs in that cluster, set [`ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER=true`](/docs/reference/configuration#ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER). Otherwise, set [`ARCHESTRA_ORCHESTRATOR_KUBECONFIG`](/docs/reference/configuration#ARCHESTRA_ORCHESTRATOR_KUBECONFIG). Agent Runtime turns on when Archestra finds the controller in the cluster. You do not need to restart Archestra after you install the controller. Check **Settings → Agents → Runtime Backend**. Create an agent with a dedicated runtime and start a run to check image access and storage provisioning.

The controller does not install a container isolation runtime. Check image architecture and admission policies before starting workloads.

| Cluster | What to Check |
| --- | --- |
| GKE | Linux node pools and the Persistent Disk CSI driver. Autopilot and GKE Sandbox do not allow privileged containers. |
| AKS | Linux agent pools and Azure Disk CSI. Review Pod Security and Azure Policy. |
| EKS with EC2 nodes | The EBS CSI driver with its IAM permissions. |
| EKS Auto Mode | A storage class with `ebs.csi.eks.amazonaws.com`, and a compatible NodePool. |
| EKS with Fargate | Not supported alone. See [EKS With Fargate](#eks-with-fargate). |
| Self-managed | A compatible OCI runtime, a CSI driver, and a dynamic storage class. |

## Storage and Placement

Runtime workspaces use dynamically provisioned `ReadWriteOnce` volumes. Set [`ARCHESTRA_AGENT_RUNTIME_WORKSPACE_STORAGE_CLASS`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_WORKSPACE_STORAGE_CLASS) to your storage class and [`ARCHESTRA_AGENT_RUNTIME_NODE_SELECTOR`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_NODE_SELECTOR) to compatible Linux nodes. For zonal disks, use `WaitForFirstConsumer` and matching node zones. Node-local storage cannot preserve files after node loss.

## EKS With Fargate

Fargate-only clusters cannot host Agent Runtime's storage. [AWS Fargate](https://docs.aws.amazon.com/eks/latest/userguide/fargate.html) does not support EBS mounts or dynamic persistent-volume provisioning.

Keep Archestra on Fargate and place runtime containers on EC2 nodes:

1. Add an EC2 node group and install the EBS CSI driver with its required IAM permissions.
2. Create an EBS storage class with `WaitForFirstConsumer` binding and configure it for runtime workspaces.
3. Label the nodes, for example `archestra-agent-runtime=true`, and use that label in the runtime node selector.
4. Exclude runtime namespaces and labels from Fargate profiles.
5. Install the controller above and start a run.

## Warm Pools

A warm pool keeps spare containers ready, so runs start faster. Agents in the same environment share a pool when their image, resources, storage, placement, and network policy match. Images tagged `:latest` always start fresh. Spares reserve CPU, memory, and storage, but hold no credentials or network access until a run takes them.

After installing the controller extensions above, set [`ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE=1`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE) to keep one spare per group. Up to four groups are prepared by default; change this with [`ARCHESTRA_AGENT_RUNTIME_WARM_POOL_MAX_POOLS`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_WARM_POOL_MAX_POOLS).

Assigned containers never return to the pool. Without a spare, a run starts a new container. Setting the size to `0` removes unused spares and preserves assigned runs.

## Privileged Containers

Ordinary coding agents do not need privilege. Docker-in-Docker and nested Kubernetes workloads may need it. Set [`ARCHESTRA_AGENT_RUNTIME_ALLOW_PRIVILEGED=true`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_ALLOW_PRIVILEGED), enable elevated permissions on the agent, and use nodes whose runtime and admission policy permit privileged containers. Use a dedicated namespace and node pool.

After resuming a run, restart Docker and development services. The deployment setting does not override cloud-provider restrictions.

<!-- SPDX-SnippetBegin -->
<!-- SPDX-SnippetCopyrightText: 2026 Archestra Inc. -->
<!-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise -->
## Runtime Image Cache

Archestra prefetches maintained catalog images onto runtime nodes. Registry and tag settings follow [`ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY) and [`ARCHESTRA_AGENT_RUNTIME_IMAGE_TAG`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_IMAGE_TAG). Custom images download when a run starts.

Prefetch uses the runtime namespace's default ServiceAccount image pull secrets. Each image consumes disk on every matching node. Fresh nodes still need their first download; an unavailable image does not block other launches.

<!-- SPDX-SnippetEnd -->

## Troubleshooting

When runs do not start:

- **Runtime unavailable:** check **Settings → Agents → Runtime Backend**, and confirm the Agent Sandbox controller is healthy.
- **Run waits on storage:** check the storage class and its capacity.
- **Image pull fails:** check the image name, registry access, and pull credentials.

Chat shows the reported startup error.
