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
import type {
  RunnerCredentialDeclaration,
  RunnerEnvironmentEntry,
  RunnerResources,
  RunnerSteerMode,
} from "@/types";
import environmentsTable from "./environment";
import secretsTable from "./secret";

/**
 * A Runner is a **definition**, not a session: the container an agent's
 * long-running work executes in. One is configured once and reused by any
 * number of agents, the way an MCP catalog entry is.
 *
 * Executions are not modelled here. A running session is an A2A task — that
 * machinery already owns the state machine, the durable event log and
 * cancellation — and `runner_sessions` records only which pod is carrying it.
 */
const runnersTable = pgTable(
  "runners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Container image. Any image with tmux and a POSIX shell. */
    image: text("image").notNull(),
    /** Command override; null runs the image's own agent entrypoint. */
    command: jsonb("command").$type<string[] | null>(),
    /**
     * How a steer message reaches the process: through the runner-agent's FIFO
     * at a turn boundary, or typed into the tmux session for a bring-your-own
     * CLI that owns its own input loop.
     */
    steerMode: text("steer_mode")
      .$type<RunnerSteerMode>()
      .notNull()
      .default("pipe"),
    /** Admin-gated: needed only by images running their own container runtime. */
    privileged: boolean("privileged").notNull().default(false),
    resources: jsonb("resources").$type<RunnerResources | null>(),
    /** Non-secret environment passed to every session on this runner. */
    environment: jsonb("environment").$type<RunnerEnvironmentEntry[] | null>(),
    /**
     * What a session needs, and at which scope. `shared` values come from
     * `secret_id`; `per_user` values come from whoever the session acts as.
     */
    credentials: jsonb("credentials").$type<
      RunnerCredentialDeclaration[] | null
    >(),
    /** Bag holding this runner's `shared`-scope credential values. */
    secretId: uuid("secret_id").references(() => secretsTable.id, {
      onDelete: "set null",
    }),
    /**
     * Environment whose namespace and egress policy sessions run under. Null =
     * the organization's default. Same optional association agents and MCP
     * servers carry, so a runner inherits network posture rather than
     * inventing one.
     */
    environmentId: uuid("environment_id").references(
      () => environmentsTable.id,
      { onDelete: "set null" },
    ),
    /** Lifetime cap for a session; null falls back to the deployment default. */
    ttlHours: integer("ttl_hours"),
    /** Stop after this long without activity; null uses the deployment default. */
    idleTimeoutMinutes: integer("idle_timeout_minutes"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("runners_organization_id_idx").on(table.organizationId),
    index("runners_environment_id_idx").on(table.environmentId),
    uniqueIndex("runners_org_name_uidx").on(table.organizationId, table.name),
  ],
);

export default runnersTable;
