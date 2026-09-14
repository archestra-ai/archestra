import client from "prom-client";
import AgentRuntimeHealthModel from "@/models/agent-runtime-health";

/** Agent IDs identify configured resources, never individual runs or arbitrary client values. */
class AgentRuntimeHealthMetrics {
  private counts?: client.Gauge;
  private ages?: client.Gauge;
  private collectedAt?: client.Gauge;
  private pending?: Promise<void>;

  initialize(): void {
    if (this.counts) return;
    this.counts = new client.Gauge({
      name: "agent_runtime_health_tasks",
      help: "Database snapshot of runtime task health. Conditions overlap; failed_recent covers 15 minutes. Use max across replicas, not sum.",
      labelNames: ["agent_id", "backend", "condition"],
      collect: () => this.refresh(),
    });
    this.collectedAt = new client.Gauge({
      name: "agent_runtime_health_collection_timestamp_seconds",
      help: "Timestamp of the last successful runtime health database snapshot, including an empty fleet.",
      collect: () => this.refresh(),
    });
    this.ages = new client.Gauge({
      name: "agent_runtime_health_age_seconds",
      help: "Oldest runtime task heartbeat, submitted task, or undelivered completion age. Use max across replicas.",
      labelNames: ["agent_id", "backend", "condition"],
      collect: () => this.refresh(),
    });
  }

  private refresh(): Promise<void> {
    // Both gauges collect concurrently during a scrape. Share that query only;
    // retain no cached snapshot that could make a failed scrape look healthy.
    this.pending ??= this.collect().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async collect(): Promise<void> {
    const rows = await AgentRuntimeHealthModel.snapshot();
    this.collectedAt?.set(Date.now() / 1000);
    this.counts?.reset();
    this.ages?.reset();
    for (const row of rows) {
      const labels = { agent_id: row.agentId, backend: row.backend };
      for (const [condition, value] of Object.entries({
        working: row.working,
        submitted: row.submitted,
        input_required: row.inputRequired,
        auth_required: row.authRequired,
        failed_recent: row.failedRecent,
        completion_pending: row.completionPending,
      }))
        this.counts?.set({ ...labels, condition }, value);
      for (const [condition, value] of Object.entries({
        heartbeat: row.heartbeatAge,
        submitted: row.submittedAge,
        completion_pending: row.completionAge,
      }))
        this.ages?.set({ ...labels, condition }, value);
    }
  }
}

export const agentRuntimeHealthMetrics = new AgentRuntimeHealthMetrics();
