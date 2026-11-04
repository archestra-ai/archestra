---
title: Sizing and High Availability
description: Size web, worker, and database capacity, and run Archestra without a single point of failure
order: 3
lastUpdated: 2026-11-04
---

Archestra's web and worker pods keep no state of their own, so you add capacity and survive a lost node by running more pods. PostgreSQL holds everything else, which makes it the one part to size carefully and to run with a standby.

## Pick a Size

Start from the row closest to your organization, then adjust from what you measure in staging. Coding agents send many more model requests per person than chat does, so size a team of coding-agent users one row up.

| Size | Typical Use | Web Pods | Worker Pods | PostgreSQL | `connectionBudget` | PostgreSQL `max_connections` |
| --- | --- | --- | ---: | --- | ---: | ---: |
| Small | One team or a pilot, up to about 100 people | 2–5, with HPA | 2 | 2 vCPU, 8 GiB, 100 GiB | 200 | 250 |
| Medium | Several teams, up to about 1,000 people | 3–8, with HPA | 2 | 4 vCPU, 16 GiB, 250 GiB | 400 | 500 |
| Large | Organization-wide | 4–16, with HPA | 4 | 8 vCPU, 32–64 GiB, 500 GiB | 800 | 1,000 |

Keep the chart's pod resources: 2 vCPU and 2 GiB requested per web pod, 2 vCPU and 1 GiB per worker pod. At the Small minimum, that is 8 vCPU and 6 GiB before PostgreSQL, MCP servers, and agent runtimes; leave room for rollout overlap and a lost node. [Cloud Recommendations](/docs/admin/deployment/database#cloud-recommendations) turns each PostgreSQL size into an instance class on AWS, Google Cloud, and Azure.

The values for the Small size, with high availability:

```yaml
postgresql:
  enabled: false # use an external database
archestra:
  horizontalPodAutoscaler:
    enabled: true
    minReplicas: 2
    maxReplicas: 5
  worker:
    replicaCount: 2
  database:
    connectionBudget: 200
  podDisruptionBudget:
    enabled: true
    maxUnavailable: 1
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
```

- The budget covers every web and worker pod at its peak, including rollout overlap. Raise it whenever you raise `maxReplicas` or the worker count; [Connection Capacity](/docs/admin/deployment/database#connection-capacity) explains the math.
- Archestra stays up while a node drains or a zone fails: the PodDisruptionBudget keeps a web pod serving, and the spread puts pods in different zones.
- The [benchmarks](/docs/admin/performance-benchmarks#llm-proxy-results) show one 4-CPU proxy handling over 800 requests per second against mock providers. In practice, the database and long model responses limit throughput before web CPU does.

## Run Without a Single Point of Failure

Run at least two of everything that serves traffic, spread across zones, and put PostgreSQL on a managed service with a standby. The values above do this for web and worker pods.

| Part | What It Holds | With More Than One Replica |
| --- | --- | --- |
| Web pods: UI, API, LLM Proxy, MCP Gateway | Nothing | Any pod serves any request. No sticky sessions are needed: chat streams and notifications reach every pod through PostgreSQL. |
| Worker pods: connector syncs, embeddings, scheduled tasks | Nothing | Workers claim each job from a queue in PostgreSQL. A job from a lost worker is retried after about five minutes. |
| PostgreSQL | Settings, logs, conversations, the job queue, and uploaded files | One primary. Use your provider's standby for failover. |
| Kubernetes Secret | Authentication and encryption keys | Back it up with the database; see [Releases and Backups](/docs/admin/deployment/production#releases-and-backups). |

Nothing needs a leader. Pods coordinate through PostgreSQL locks, so you can add or remove web and worker pods at any time, and migrations run once however many pods start together. No Redis or other shared store is needed.

- The PodDisruptionBudget covers web pods only. Node drains can evict workers at any time; their jobs resume on another worker.
- Uploaded files live in PostgreSQL by default. With [`ARCHESTRA_FILE_STORAGE_PROVIDER=filesystem`](/docs/admin/deployment/configuration#ARCHESTRA_FILE_STORAGE_PROVIDER), every web and worker pod needs the same ReadWriteMany volume; use `s3` instead to keep pods free of shared disks.
- Each self-hosted MCP server runs as one pod. Kubernetes restarts it on another node if its node fails, and tool calls to it fail until it is back.

### Database Failover

A managed database with a standby in another zone fails over on its own; Archestra reconnects without a restart. While the standby takes over:

- Web pods report not ready, so the ingress briefly returns errors. Liveness does not depend on the database, so Kubernetes does not restart them.
- Requests in flight at that moment can fail, including a chat response being written.
- Pods return to ready as soon as the new primary accepts connections.

A read replica adds no capacity: Archestra sends every query to the primary. Use replicas only for failover and for your own reporting.

## Scale From What You Measure

Change one thing at a time, and change the connection budget with any change to pod counts.

| What You See | What to Change |
| --- | --- |
| Web pods sit at the HPA maximum | Raise `maxReplicas` and `connectionBudget`. The HPA scales on memory; add a CPU target under `archestra.horizontalPodAutoscaler.metrics` if pods run hot on CPU first. |
| Connector syncs or embeddings fall behind | Add worker pods with `archestra.worker.replicaCount`, and raise `connectionBudget`. |
| Database CPU stays high, or requests wait for connections | Move PostgreSQL to the next instance size. Adding pods makes this worse. |
| Database storage grows fast | Logs grow with every model request and tool call. Set [log retention](/docs/admin/deployment/configuration#data-retention), or store metadata only with [`ARCHESTRA_LOGS_CONTENT_MODE`](/docs/admin/deployment/configuration#ARCHESTRA_LOGS_CONTENT_MODE). |
| Knowledge searches slow down as the knowledge base grows | Give PostgreSQL enough memory to keep the vector index cached: about 6 GiB per million chunks with 1,536-dimension embeddings. |

MCP servers and agent runtimes run in their own pods and scale separately; see [Cluster Capacity](/docs/admin/deployment/production#cluster-capacity).
