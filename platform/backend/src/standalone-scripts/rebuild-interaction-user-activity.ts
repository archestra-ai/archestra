import db, { initializeDatabase } from "@/database";
import { assertPortsBound } from "@/models/ports";
import { bindAllPorts } from "@/server/composition";
import {
  parseInteractionUserActivityArguments,
  rebuildInteractionUserActivityCommand,
} from "./rebuild-interaction-user-activity-command";

// Bind the ports of the layers below before anything uses them, and stop here
// if one is unbound (server/composition.ts).
bindAllPorts();
assertPortsBound();

const options = parseInteractionUserActivityArguments(process.argv.slice(2));
await initializeDatabase();
try {
  process.exitCode = await rebuildInteractionUserActivityCommand(options);
} finally {
  await db.$client.end();
}
