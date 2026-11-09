// Binds the ports of the layers below before any other module loads.
import "@/server/composition";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getArchestraToolShortName } from "@archestra/shared";
import { generateObject } from "ai";
import { z } from "zod";
import { getAllArchestraMcpTools } from "@/archestra-mcp-server";
import {
  hashToolDefinition,
  parseSearchText,
  TOOL_SEARCH_TEXT_SYSTEM_PROMPT,
  type ToolDefinition,
} from "@/archestra-mcp-server/search-text";
import logger from "@/logging";
import { assertPortsBound } from "@/models/ports";

assertPortsBound();

const MODEL = "claude-opus-5-5";
const CONCURRENCY = 4;
const OUTPUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../archestra-mcp-server/search-texts.generated.json",
);

type Entry = { definitionHash: string; searchText: string };

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  const model = createAnthropic({ apiKey })(MODEL);

  const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8")) as Record<
    string,
    Entry
  >;
  const tools = getAllArchestraMcpTools().flatMap((tool) => {
    const shortName = getArchestraToolShortName(tool.name);
    if (!shortName) return [];
    const definition: ToolDefinition = {
      name: tool.name,
      description: tool.description ?? null,
      parameters: tool.inputSchema as Record<string, unknown>,
    };
    return [{ shortName, definition, hash: hashToolDefinition(definition) }];
  });

  const entries = new Map(
    tools.flatMap(({ hash, shortName }) => {
      const entry = existing[shortName];
      return entry?.definitionHash === hash
        ? [[shortName, entry] as const]
        : [];
    }),
  );
  const stale = tools.filter(({ shortName }) => !entries.has(shortName));

  let failed = 0;
  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    await Promise.all(
      stale.slice(i, i + CONCURRENCY).map(async (tool) => {
        try {
          const searchText = await generate(model, tool.definition);
          entries.set(tool.shortName, {
            definitionHash: tool.hash,
            searchText,
          });
        } catch (error) {
          failed += 1;
          logger.error(
            { err: error, tool: tool.shortName },
            "Generation failed",
          );
          const previous = existing[tool.shortName];
          if (previous) entries.set(tool.shortName, previous);
        }
      }),
    );
  }

  const sorted = Object.fromEntries(
    [...entries.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  logger.info(
    { total: tools.length, attempted: stale.length, failed },
    "Generated built-in tool search texts",
  );
  if (failed > 0) process.exitCode = 1;
}

// An empty text is stored too, so a rerun does not pay for it again.
async function generate(
  model: Parameters<typeof generateObject>[0]["model"],
  definition: ToolDefinition,
): Promise<string> {
  const { object } = await generateObject({
    model,
    schema: z.object({ search_text: z.string() }),
    system: TOOL_SEARCH_TEXT_SYSTEM_PROMPT,
    prompt: JSON.stringify(definition),
  });
  const parsed = parseSearchText(removeBrandToken(object.search_text));
  switch (parsed.status) {
    case "ready":
      return parsed.searchText;
    case "empty":
      return "";
    case "failed":
      throw new Error("Generated search text is too long");
  }
}

// White-labeled deployments must not match the default brand through this field.
function removeBrandToken(text: string): string {
  return text
    .replace(/\barchestra\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

await main();
process.exit();
