import { describe, expect, it } from "vitest";

import { tools as sandboxTools } from "./sandbox";
import { tools as skillTools } from "./skills";

/**
 * Characterization snapshot of every LLM-facing string in the skill and
 * sandbox tool surfaces: tool names, titles, descriptions, and input schemas
 * (including field `description`s). These strings steer model behavior; a
 * snapshot diff here is a semantic change to what models read.
 */
describe("skill and sandbox tool text", () => {
  it.each(
    [...skillTools, ...sandboxTools].map((tool) => [tool.name, tool]),
  )("%s", (_name, tool) => {
    expect({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }).toMatchSnapshot();
  });
});
