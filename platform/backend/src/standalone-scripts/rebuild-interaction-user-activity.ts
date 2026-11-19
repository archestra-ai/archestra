// Binds the ports of the layers below before any other module loads.
import "@/server/composition";
import db, { initializeDatabase } from "@/database";
import { assertPortsBound } from "@/models/ports";
import {
  parseInteractionUserActivityArguments,
  rebuildInteractionUserActivityCommand,
} from "./rebuild-interaction-user-activity-command";

// The composition module, imported first, bound the ports of the layers
// below; stop here if one is unbound.
assertPortsBound();

const options = parseInteractionUserActivityArguments(process.argv.slice(2));
await initializeDatabase();
try {
  process.exitCode = await rebuildInteractionUserActivityCommand(options);
} finally {
  await db.$client.end();
}
