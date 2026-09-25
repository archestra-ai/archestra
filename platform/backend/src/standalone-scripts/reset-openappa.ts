// biome-ignore-all lint/suspicious/noConsole: standalone dev CLI — console for TTY UX
/**
 * Put OpenAPPA back to its first-run state so the Overview setup cards can be checked.
 *
 * Turns the deployment switch off and deletes, for every organization, the
 * policy revisions (the policy reads as the built-in default again), the
 * battery rows and uploaded packages, the composed policy and the GitHub sync
 * source. The runtime ledger (sessions, events, decisions) is left alone.
 *
 * Development only. Run from `backend/`:
 *
 *   pnpm db:reset-openappa
 */
import config from "@/config";
import db, { initializeDatabase } from "@/database";
import {
  guardrailsDeploymentTable,
  guardrailsPolicyRevisionsTable,
  openappaBatteryInstallsTable,
  openappaBatteryPackagesTable,
  openappaEffectivePoliciesTable,
  openappaGithubSyncTable,
} from "@/database/schemas";

async function main() {
  if (config.production)
    throw new Error("Refusing to reset OpenAPPA in production.");
  await initializeDatabase();
  await db.transaction(async (tx) => {
    await tx.update(guardrailsDeploymentTable).set({ enabled: false });
    for (const table of [
      openappaBatteryInstallsTable,
      openappaEffectivePoliciesTable,
      openappaGithubSyncTable,
      openappaBatteryPackagesTable,
      guardrailsPolicyRevisionsTable,
    ])
      await tx.delete(table);
  });
  console.log(
    "[reset-openappa] OpenAPPA is off and back to the default policy.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[reset-openappa] failed:", err);
    process.exit(1);
  });
