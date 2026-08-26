import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { RunnerResources, RunnerState, RunnerSteerMode } from "@/types";
import agentsTable from "./agent";
import environmentsTable from "./environment";
import usersTable from "./user";
import virtualApiKeysTable from "./virtual-api-key";

/**
 * A Runner is one long-running agentic session executing inside its own
 * Kubernetes pod: an agent's configured image, started on a user's behalf,
 * kept alive across backend restarts, and steerable/attachable while it runs.
 *
 * This row is the source of truth; the pod is cattle. A pod that disappears
 * is reported as a failed runner on the next reconcile pass rather than left
 * looking alive. Every object the runtime creates carries the
 * `archestra.io/purpose=runner` label, so a convergence sweep can find them.
 *
 * Deliberately unlike `skill_sandboxes`: that model replays an ordered log into
 * a fresh ephemeral Dagger container per command and keeps no live process.
 * A Runner is the inverse — the live process IS the state, which is why it
 * rides the Kubernetes pod path rather than the Dagger replay path.
 */
const runnersTable = pgTable(
  "runners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** Agent supplying the image, credential declarations and tool access. */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    /**
     * The human this runner acts as. Their personal credentials and LLM-proxy
     * attribution are bound to it, so the runner cannot outlive the account.
     */
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    state: text("state").$type<RunnerState>().notNull().default("pending"),
    /** Human-readable explanation for the current state (failure cause, stop reason). */
    statusReason: text("status_reason"),
    /**
     * Environment snapshotted from the agent at spawn. Drives which network
     * policy the pod runs under; kept even if the agent is later re-pointed so
     * a live runner's egress posture never changes underneath it.
     */
    environmentId: uuid("environment_id").references(
      () => environmentsTable.id,
      { onDelete: "set null" },
    ),
    /** Resolved container image (agent's configured image, or the platform default). */
    image: text("image").notNull(),
    /** Command override; null runs the image's own entrypoint. */
    command: jsonb("command").$type<string[] | null>(),
    /** Initial task/prompt handed to the agent loop on start. */
    task: text("task"),
    /**
     * How a steer message reaches the running process: `pipe` writes to the
     * runner-agent FIFO (injected at a turn boundary), `tmux_keys` types into
     * the tmux session (the bring-your-own-image path, e.g. Claude Code).
     */
    steerMode: text("steer_mode")
      .$type<RunnerSteerMode>()
      .notNull()
      .default("pipe"),
    /** Admin-gated: required by images that run their own container runtime. */
    privileged: boolean("privileged").notNull().default(false),
    resources: jsonb("resources").$type<RunnerResources | null>(),
    /**
     * Kubernetes deployment name, frozen on first successful provision so a
     * later rename of the runner can never orphan the workload.
     */
    deploymentName: text("deployment_name"),
    namespace: text("namespace"),
    /** Per-runner K8s Secret holding injected credentials; deleted on teardown. */
    secretName: text("secret_name"),
    /**
     * Personal-scope virtual key minted for this runner so LLM spend attributes
     * to `created_by_user_id`. Revoked and nulled during teardown — a key that
     * outlived its pod would keep working and keep charging its creator.
     */
    virtualApiKeyId: uuid("virtual_api_key_id").references(
      () => virtualApiKeysTable.id,
      { onDelete: "set null" },
    ),
    /** Hard lifetime cap; null disables TTL expiry. */
    ttlHours: integer("ttl_hours"),
    /** Stop after this long without a steer/attach; null disables idle stop. */
    idleTimeoutMinutes: integer("idle_timeout_minutes"),
    lastActivityAt: timestamp("last_activity_at", { mode: "date" }),
    startedAt: timestamp("started_at", { mode: "date" }),
    stoppedAt: timestamp("stopped_at", { mode: "date" }),
    /**
     * Next event sequence to allocate, bumped atomically on append so every
     * event has a stable total order independent of clock skew.
     */
    nextEventSequence: integer("next_event_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("runners_organization_id_idx").on(table.organizationId),
    index("runners_agent_id_idx").on(table.agentId),
    index("runners_created_by_user_id_idx").on(table.createdByUserId),
    index("runners_state_idx").on(table.state),
    // Deployment names are frozen and must stay globally unique so an adopt
    // pass can never bind two runners to the same workload.
    uniqueIndex("runners_deployment_name_uidx").on(table.deploymentName),
  ],
);

export default runnersTable;
