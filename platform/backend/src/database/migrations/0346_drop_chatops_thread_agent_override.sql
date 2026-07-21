-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=Removes the storage behind the deprecated swap_agent/swap_to_default_agent tools. The table's only writer (the swap tool handlers) and only reader (the ChatOps thread-override handoff) are deleted in this same release, and the rows are ephemeral per-thread runtime state, so there is no old code path worth an expand/contract rollout.
DROP TABLE "chatops_thread_agent_override" CASCADE;
