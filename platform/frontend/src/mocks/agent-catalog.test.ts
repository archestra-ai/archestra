import { describe, expect, it } from "vitest";
import { resolveMockResponse } from "./resolve";

async function catalog(query: string) {
  const response = await resolveMockResponse(
    new Request(`http://localhost:9000/api/agent-catalog?${query}`),
  );
  expect(response?.status).toBe(200);
  return response?.json();
}

describe("preview agent catalog", () => {
  it("shows built-ins when requested, including the mine access filter", async () => {
    const result = await catalog(
      "includeBuiltIn=true&access=mine&pinned=false",
    );
    expect(
      result.data.map((row: { value: { name: string } }) => row.value.name),
    ).toContain("OpenAPPA Configuration Agent");
    expect(result.data).toHaveLength(4);
  });

  it("keeps built-ins out of the default and pinned lists", async () => {
    expect((await catalog("access=mine")).data).toEqual([]);
    expect((await catalog("includeBuiltIn=true&pinned=true")).data).toEqual([]);
  });

  it("filters built-ins by name", async () => {
    const result = await catalog("scope=built_in&name=compaction");
    expect(result.data).toHaveLength(1);
    expect(result.data[0].value.name).toBe("Context Compaction Subagent");
  });
});
