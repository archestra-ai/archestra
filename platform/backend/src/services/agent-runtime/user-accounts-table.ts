import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { AGENT_RUNTIME_USER_ACCOUNTS_STATEMENTS } from "@/database/agent-runtime-user-accounts-sql";
import logger from "@/logging";
import AgentRuntimeUserAccountModel from "@/models/agent-runtime-user-account";
import StartupMigrationModel from "@/models/startup-migration";

/**
 * Create the table of each person's Agent Runtime account choice, once per
 * database, before this process serves requests or runs tasks. The web
 * server and the worker both call it: one creates the table, the others wait
 * for it. Never throws, so a database that cannot take the table keeps
 * running as before, with no choice for anyone.
 *
 * The statements create an empty table, its keys and its indexes, and change
 * no row. Each foreign key locks its referenced table (agents, user,
 * chat_api_keys or models) against writes until the upgrade commits, which
 * takes milliseconds once the locks are held. A transaction that keeps
 * writing to one of those tables makes an attempt give up after
 * LOCK_TIMEOUT, so writers wait at most that long; the next attempt follows
 * after a pause.
 */
export async function ensureAgentRuntimeUserAccountsTable(): Promise<void> {
  let waitingForOtherProcess = false;
  for (let lockAttempt = 1; ; ) {
    try {
      const done = await StartupMigrationModel.tryRun({
        id: STARTUP_MIGRATION_ID,
        migrate: async (tx) => {
          await tx.execute(
            sql.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`),
          );
          for (const statement of AGENT_RUNTIME_USER_ACCOUNTS_STATEMENTS) {
            await tx.execute(sql.raw(statement));
          }
        },
      });
      if (done) return;
      if (!waitingForOtherProcess) {
        logger.info(
          "[AgentRuntime] Waiting for another process to create the account choice table",
        );
        waitingForOtherProcess = true;
      }
      await sleep(1000);
    } catch (error) {
      if (
        postgresErrorCode(error) === LOCK_NOT_AVAILABLE &&
        lockAttempt < MAX_LOCK_ATTEMPTS
      ) {
        const pauseMs = Math.min(5_000 * 2 ** (lockAttempt - 1), 60_000);
        logger.warn(
          { attempt: lockAttempt, pauseMs },
          "[AgentRuntime] Creating the account choice table waits for a transaction that writes to agents, users, API keys or models; trying again",
        );
        lockAttempt++;
        await sleep(pauseMs);
        continue;
      }
      AgentRuntimeUserAccountModel.tableAvailable = false;
      logger.error(
        { err: error },
        "[AgentRuntime] Could not create the account choice table. Until a restart creates it, nobody can choose their own account, and every run uses the agent's own account. The database user must be able to create tables in the public schema and reference agents, user, chat_api_keys and models.",
      );
      return;
    }
  }
}

const STARTUP_MIGRATION_ID = "agent-runtime-user-accounts-table-v1";
const LOCK_TIMEOUT = "5s";
const MAX_LOCK_ATTEMPTS = 8;
const LOCK_NOT_AVAILABLE = "55P03";

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? postgresErrorCode(error.cause) : undefined;
}
