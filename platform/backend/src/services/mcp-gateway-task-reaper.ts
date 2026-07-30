import logger from "@/logging";
import { McpGatewayTaskModel } from "@/models";
import { TASK_TTL_MS } from "@/routes/mcp-gateway/tasks";

/**
 * Post-TTL lifecycle for gateway-minted MCP tasks, in the two steps the Tasks
 * extension sanctions: after the TTL a server "MAY mark a task as `failed` …
 * and subsequently delete it at any time".
 *
 * Step one settles orphans: a row still `working` past its expiry belongs to
 * an execution whose replica died before writing an outcome (a deploy or a
 * crash mid-task), and flipping it to `failed` makes the table tell the
 * truth. Step two bounds the table: rows whose expiry is at least a full TTL
 * in the past — nothing has been able to read them since they expired — are
 * deleted, keeping recent outcomes inspectable for operators while stopping
 * the accumulation the schema's expires_at index was built for.
 *
 * Always on, no knob: both queries are cheap, guarded, and idempotent, so
 * every replica sweeping independently is safe — one pod's sweep just finds
 * nothing left to do.
 */
class McpGatewayTaskReaper {
  private intervalId: NodeJS.Timeout | null = null;
  private sweepInProgress = false;

  start(): void {
    if (this.intervalId) {
      return;
    }
    this.intervalId = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    // Never keep the process alive just for the reaper.
    this.intervalId.unref();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * One sweep — what each interval tick runs. Public so it can be invoked
   * directly (tests, future operator surfaces) without waiting for the timer.
   */
  async sweep(): Promise<{ failed: number; purged: number }> {
    // A slow sweep must not stack onto the next tick.
    if (this.sweepInProgress) {
      return { failed: 0, purged: 0 };
    }
    this.sweepInProgress = true;
    try {
      const failed = await McpGatewayTaskModel.failExpired();
      const purged = await McpGatewayTaskModel.purgeExpired({
        graceMs: PURGE_GRACE_MS,
      });
      if (failed > 0 || purged > 0) {
        logger.info(
          { failed, purged },
          "Reaped expired MCP gateway tasks (failed orphans marked, old rows purged)",
        );
      }
      return { failed, purged };
    } catch (error) {
      // The reaper is housekeeping; a failed sweep must never take anything
      // else down, and the next tick retries anyway.
      logger.warn({ err: error }, "MCP gateway task reaper sweep failed");
      return { failed: 0, purged: 0 };
    } finally {
      this.sweepInProgress = false;
    }
  }
}

export const mcpGatewayTaskReaper = new McpGatewayTaskReaper();

// =============================================================================
// Internal constants
// =============================================================================

/** Sweep cadence — a fraction of the 30-minute TTL so orphans settle promptly. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long past expiry a row survives before deletion — one full TTL, i.e.
 * rows live for 2× TTL from creation. Reads refuse rows the moment they
 * expire, so the grace changes nothing for clients; it is the operator
 * inspection window.
 */
const PURGE_GRACE_MS = TASK_TTL_MS;
