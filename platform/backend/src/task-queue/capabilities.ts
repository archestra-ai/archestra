export type QueueFeature =
  | "postgres-backed-persistence"
  | "delayed-scheduling"
  | "retry-with-backoff"
  | "dead-letter-state"
  | "worker-concurrency-limit"
  | "graceful-shutdown-drain"
  | "stuck-task-recovery"
  | "periodic-task-rescheduling"
  | "periodic-singleton-seeding"
  | "ack-late-attempt-semantics"
  | "handler-registration-by-type";

export type CapabilityStatus = "supported" | "partial" | "unsupported";

export type QueueCapability = {
  feature: QueueFeature;
  required: boolean;
  current: CapabilityStatus;
  pgBoss: CapabilityStatus;
  notes: string;
};

export const TASK_QUEUE_CAPABILITY_MATRIX: QueueCapability[] = [
  {
    feature: "postgres-backed-persistence",
    required: true,
    current: "supported",
    pgBoss: "supported",
    notes: "Both implementations persist jobs in Postgres.",
  },
  {
    feature: "delayed-scheduling",
    required: true,
    current: "supported",
    pgBoss: "supported",
    notes: "Current queue uses scheduledFor; pg-boss supports delayed jobs.",
  },
  {
    feature: "retry-with-backoff",
    required: true,
    current: "supported",
    pgBoss: "supported",
    notes: "Current queue has exponential backoff; pg-boss supports retry options.",
  },
  {
    feature: "dead-letter-state",
    required: true,
    current: "supported",
    pgBoss: "supported",
    notes: "Current queue marks tasks dead; pg-boss supports failed/dead-letter handling.",
  },
  {
    feature: "worker-concurrency-limit",
    required: true,
    current: "supported",
    pgBoss: "supported",
    notes: "Current queue enforces max in-flight tasks; pg-boss supports worker concurrency.",
  },
  {
    feature: "graceful-shutdown-drain",
    required: true,
    current: "supported",
    pgBoss: "supported",
    notes: "Current queue drains and releases in-flight tasks; pg-boss has worker stop/shutdown controls.",
  },
  {
    feature: "stuck-task-recovery",
    required: true,
    current: "supported",
    pgBoss: "supported",
    notes: "Current queue periodically resets stuck tasks; pg-boss has job expiration/maintenance semantics.",
  },
  {
    feature: "periodic-task-rescheduling",
    required: true,
    current: "supported",
    pgBoss: "supported",
    notes: "Current queue re-enqueues periodic definitions; pg-boss supports recurring/scheduled jobs.",
  },
  {
    feature: "periodic-singleton-seeding",
    required: true,
    current: "supported",
    pgBoss: "partial",
    notes: "Current queue relies on unique constraints and explicit seed checks. pg-boss requires explicit singleton strategy for recurring jobs across replicas.",
  },
  {
    feature: "ack-late-attempt-semantics",
    required: true,
    current: "supported",
    pgBoss: "partial",
    notes: "Current queue decrements attempts when interrupted tasks are released. Equivalent semantics need validation with pg-boss retry/expire behavior.",
  },
  {
    feature: "handler-registration-by-type",
    required: true,
    current: "supported",
    pgBoss: "supported",
    notes: "Current queue dispatches by taskType; pg-boss supports named queues/workers.",
  },
];
