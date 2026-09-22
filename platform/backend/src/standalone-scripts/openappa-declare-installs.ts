// biome-ignore-all lint/suspicious/noConsole: standalone operator/CI script — console for TTY UX
/**
 * OpenAPPA battery installs → policy declarations.
 *
 * Batteries are declared in the organization's policy text now: composition
 * reads `include`, `[server_aliases]` and `[credentials]` from it, and every
 * recompose rewrites `openappa_battery_installs` from that text, deleting the
 * rows it does not declare. This one-shot authors those declarations from the
 * legacy rows, so it must run before the first recompose after the deploy.
 *
 * The backend runs it at startup too (before the runtime opens and before the
 * periodic recompile is registered). This script is for operators who run
 * migrations out of band — the Helm migration Job, chained after
 * `drizzle-kit migrate`. It is idempotent: a second run finds every
 * organization's text already saying what its rows say and writes nothing.
 *
 * Run (dev, from backend/):
 *   pnpm db:openappa-declare-installs
 * Run (prod image, from /app/backend):
 *   node dist/standalone-scripts/openappa-declare-installs.mjs
 *
 * Needs the same DB env as the server. Exits non-zero when any organization
 * failed: its rows are still the only record of its installs, and the log names
 * every one of them.
 */
import { declareExistingInstalls } from "@/openappa/declare-installs";

async function main(): Promise<number> {
  const summary = await declareExistingInstalls();
  console.log(
    `[openappa-declare-installs] done: declared=${summary.declared.length} ` +
      `unchanged=${summary.unchanged.length} failed=${summary.failed.length}`,
  );
  if (summary.failed.length === 0) return 0;
  console.error(
    `[openappa-declare-installs] organizations still undeclared: ${summary.failed.join(", ")}`,
  );
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[openappa-declare-installs] failed:", err);
    process.exit(1);
  });
