import db, { initializeDatabase } from "@/database";
import {
  parseInteractionUserActivityArguments,
  rebuildInteractionUserActivityCommand,
} from "./rebuild-interaction-user-activity-command";

const options = parseInteractionUserActivityArguments(process.argv.slice(2));
await initializeDatabase();
try {
  process.exitCode = await rebuildInteractionUserActivityCommand(options);
} finally {
  await db.$client.end();
}
