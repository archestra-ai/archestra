import { pathToFileURL } from "node:url";
import { initializeDatabase } from "@/database";
import logger from "@/logging";
import {
  DEFAULT_CHAT_BASE_URL,
  type SeedChatScenariosOptions,
  seedChatScenarios,
} from "./seed-chat-scenarios-service";

export function parseSeedChatScenariosArgs(
  args: string[],
): SeedChatScenariosOptions {
  const options: SeedChatScenariosOptions = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === "--keep-existing") {
      options.keepExisting = true;
      continue;
    }

    if (arg === "--scenario") {
      const scenarioId = args[index + 1];
      if (!scenarioId || scenarioId.startsWith("--")) {
        throw new Error("--scenario requires a scenario id");
      }
      options.scenarioId = scenarioId;
      index++;
      continue;
    }

    if (arg === "--chat-base-url") {
      const chatBaseUrl = args[index + 1];
      if (!chatBaseUrl || chatBaseUrl.startsWith("--")) {
        throw new Error("--chat-base-url requires a URL");
      }
      options.chatBaseUrl = chatBaseUrl;
      index++;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseSeedChatScenariosArgs(args);
  await initializeDatabase();

  const results = await seedChatScenarios({
    chatBaseUrl: DEFAULT_CHAT_BASE_URL,
    ...options,
  });

  logger.info("\nSeeded chat debug conversations:");
  for (const result of results) {
    logger.info(`- ${result.scenarioId}: ${result.url}`);
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to seed chat debug scenarios",
      );
      process.exit(1);
    });
}
