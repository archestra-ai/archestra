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

// No args: generate stale entries with the Anthropic API.
// `--list-stale <out.json>`: write the stale definitions with their hashes,
// for writing texts by hand (following TOOL_SEARCH_TEXT_SYSTEM_PROMPT).
// `--apply <texts.json>`: store a `{ shortName: { definitionHash, searchText } }`
// file, refusing an entry whose definition changed since it was listed.
type Mode =
  | { kind: "generate" }
  | { kind: "list-stale"; outPath: string }
  | { kind: "apply"; textsPath: string };

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
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

  if (mode.kind === "list-stale") {
    const definitions = stale.map(({ shortName, definition, hash }) => ({
      shortName,
      definitionHash: hash,
      definition,
    }));
    fs.writeFileSync(mode.outPath, `${JSON.stringify(definitions, null, 2)}\n`);
    logger.info({ stale: stale.length }, "Wrote stale tool definitions");
    return;
  }

  let failed = 0;
  if (mode.kind === "apply") {
    const texts = z
      .record(
        z.string(),
        z.object({ definitionHash: z.string(), searchText: z.string() }),
      )
      .parse(JSON.parse(fs.readFileSync(mode.textsPath, "utf8")));
    const staleByName = new Map<string, (typeof stale)[number]>(
      stale.map((tool) => [tool.shortName, tool]),
    );
    for (const [shortName, supplied] of Object.entries(texts)) {
      const tool = staleByName.get(shortName);
      if (!tool) throw new Error(`${shortName} is not a stale entry`);
      // The text was written for the exported definition; one that changed
      // since must be listed and written again.
      if (supplied.definitionHash !== tool.hash) {
        throw new Error(`${shortName} changed since --list-stale`);
      }
      entries.set(tool.shortName, {
        definitionHash: tool.hash,
        searchText: toStoredText(supplied.searchText),
      });
    }
    for (const { shortName } of stale) {
      if (entries.has(shortName)) continue;
      failed += 1;
      logger.error({ tool: shortName }, "No text supplied for a stale entry");
      const previous = existing[shortName];
      if (previous) entries.set(shortName, previous);
    }
  } else {
    failed = await generateStale({ stale, entries, existing });
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

function parseMode(args: string[]): Mode {
  const [flag, path] = args;
  switch (flag) {
    case undefined:
      return { kind: "generate" };
    case "--list-stale":
      if (!path) throw new Error("--list-stale needs an output path");
      return { kind: "list-stale", outPath: path };
    case "--apply":
      if (!path) throw new Error("--apply needs a texts file path");
      return { kind: "apply", textsPath: path };
    default:
      throw new Error(`Unknown argument ${flag}`);
  }
}

async function generateStale(params: {
  stale: { shortName: string; definition: ToolDefinition; hash: string }[];
  entries: Map<string, Entry>;
  existing: Record<string, Entry>;
}): Promise<number> {
  const { stale, entries, existing } = params;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
  const model = createAnthropic({ apiKey })(MODEL);

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
  return failed;
}

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
  return toStoredText(object.search_text);
}

// An empty text is stored too, so a rerun does not pay for it again.
function toStoredText(text: string): string {
  const parsed = parseSearchText(removeBrandToken(text));
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
