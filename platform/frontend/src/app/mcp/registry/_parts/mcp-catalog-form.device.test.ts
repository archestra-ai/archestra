// @vitest-environment node
import { describe, expect, test } from "vitest";
import { makeCatalogItem } from "@/mocks/data/catalog";
import { formSchema } from "./mcp-catalog-form.types";
import {
  transformCatalogItemToFormValues,
  transformFormToApiData,
} from "./mcp-catalog-form.utils";

const config = {
  protocolVersion: 1 as const,
  version: "1.0.0",
  platforms: {
    darwin: { command: "node", args: ["/server.mjs"] },
    win32: { command: "node.exe", args: ["C:/server.mjs"] },
  },
  tools: [{ name: "echo", inputSchema: { type: "object" as const } }],
};

describe("device configuration editing", () => {
  test("round-trips reviewed device launches with their registry metadata", () => {
    const catalog = makeCatalogItem({
      serverType: "device",
      deviceConfig: config,
      labels: [{ key: "purpose", value: "engineering" }],
      environmentId: "00000000-0000-4000-8000-000000000001",
    });
    const draft = transformCatalogItemToFormValues(catalog);
    expect(formSchema.safeParse(draft).success).toBe(true);
    const saved = transformFormToApiData(draft);
    expect(saved.deviceConfig).toEqual(config);
    expect(saved.labels).toEqual(catalog.labels);
    expect(saved.environmentId).toBe(catalog.environmentId);
    expect(saved.localConfig).toBeNull();
    expect(saved.oauthConfig).toBeNull();
  });
  test("refuses malformed device manifests without validating inactive Kubernetes fields", () => {
    const draft = transformCatalogItemToFormValues(
      makeCatalogItem({ serverType: "device", deviceConfig: config }),
    );
    const invalid = formSchema.safeParse({ ...draft, deviceConfigJson: "{" });
    expect(invalid.success).toBe(false);
    if (!invalid.success)
      expect(
        invalid.error.issues.some(
          (issue) => issue.path[0] === "deviceConfigJson",
        ),
      ).toBe(true);
  });
});
