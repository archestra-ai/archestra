import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import LimitModel from "@/models/limit";
import ToolModel from "@/models/tool";
import { describe, expect, test } from "@/test";
import {
  mintCatalogToolNames,
  reconcileCatalogToolPrefixes,
} from "./mcp-tool-names";

/** 45 characters: with these tool names, over the 64-character limit. */
const LONG_NAME = "Acme Planning Board Description Review Server";
const PREPARE = "prepare-description-review";
const VALIDATE = "validate-description-review";
/** What the old format appended to a cut prefix: `-` and 8 hex characters. */
const HASH_SUFFIX = /-[0-9a-f]{8}__/;

describe("mintCatalogToolNames", () => {
  test("keeps the slugified name while every tool fits", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({ name: "GitHub Issues" });

    const nameFor = await mintCatalogToolNames({
      catalogId: catalog.id,
      rawToolNames: ["list_issues"],
    });

    expect(nameFor("list_issues")).toBe("github_issues__list_issues");
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.toolPrefix,
    ).toBeNull();
  });

  test("cuts a long name at a word boundary, one prefix for every tool and no hash", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({ name: LONG_NAME });

    const nameFor = await mintCatalogToolNames({
      catalogId: catalog.id,
      rawToolNames: [PREPARE, VALIDATE],
    });

    expect(nameFor(PREPARE)).toBe(
      "acme_planning_board_description__prepare-description-review",
    );
    expect(nameFor(VALIDATE)).toBe(
      "acme_planning_board_description__validate-description-review",
    );
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.toolPrefix,
    ).toBe("acme_planning_board_description");
  });

  test("counts apart a different name that cuts to the same prefix", async ({
    makeInternalMcpCatalog,
  }) => {
    const first = await makeInternalMcpCatalog({ name: LONG_NAME });
    const second = await makeInternalMcpCatalog({
      name: "Acme Planning Board Description Review Staging",
    });

    const firstName = await mintCatalogToolNames({
      catalogId: first.id,
      rawToolNames: [VALIDATE],
    });
    const secondName = await mintCatalogToolNames({
      catalogId: second.id,
      rawToolNames: [VALIDATE],
    });

    expect(firstName(VALIDATE)).toBe(
      "acme_planning_board_description__validate-description-review",
    );
    expect(secondName(VALIDATE)).toBe(
      "acme_planning_board_description-2__validate-description-review",
    );
  });

  test("gives two apps of one name their own launch tool names", async ({
    makeInternalMcpCatalog,
  }) => {
    const first = await makeInternalMcpCatalog({
      name: "Weather",
      serverType: "app",
    });
    const second = await makeInternalMcpCatalog({
      name: "Weather",
      serverType: "app",
    });

    const firstName = await mintCatalogToolNames({
      catalogId: first.id,
      rawToolNames: ["open"],
    });
    const secondName = await mintCatalogToolNames({
      catalogId: second.id,
      rawToolNames: ["open"],
    });

    expect(firstName("open")).toBe("weather__open");
    expect(secondName("open")).toBe("weather-2__open");
  });

  test("moves the item's stored tools when a new tool needs a shorter prefix", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ name: LONG_NAME });
    const stored = await makeTool({
      name: ToolModel.slugifyName(LONG_NAME, "list"),
      rawName: "list",
      catalogId: catalog.id,
    });
    expect(stored.name).toBe(
      "acme_planning_board_description_review_server__list",
    );

    const nameFor = await mintCatalogToolNames({
      catalogId: catalog.id,
      rawToolNames: [VALIDATE],
    });

    expect(nameFor(VALIDATE)).toBe(
      "acme_planning_board_description__validate-description-review",
    );
    expect((await ToolModel.findById(stored.id))?.name).toBe(
      "acme_planning_board_description__list",
    );
  });
});

describe("reconcileCatalogToolPrefixes", () => {
  test("renames cut-and-hashed tools and the limits keyed on them, keeping their ids", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ name: LONG_NAME });
    const hashedName = ToolModel.slugifyName(LONG_NAME, VALIDATE);
    expect(hashedName).toMatch(HASH_SUFFIX);
    const tool = await makeTool({
      name: hashedName,
      rawName: VALIDATE,
      catalogId: catalog.id,
    });
    const agent = await makeAgent();
    const limit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "tool_calls",
      limitValue: 10,
      toolName: hashedName,
    });

    const renamed = await reconcileCatalogToolPrefixes();

    expect(renamed).toEqual([catalog.id]);
    const after = await ToolModel.findById(tool.id);
    expect(after?.name).toBe(
      "acme_planning_board_description__validate-description-review",
    );
    expect((await LimitModel.findById(limit.id))?.toolName).toBe(after?.name);
    // Idempotent: a second boot finds nothing to move.
    expect(await reconcileCatalogToolPrefixes()).toEqual([]);
  });

  test("leaves an item whose tools already fit untouched", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ name: "GitHub" });
    const tool = await makeTool({
      name: "github__list_issues",
      rawName: "list_issues",
      catalogId: catalog.id,
    });

    expect(await reconcileCatalogToolPrefixes()).toEqual([]);
    expect((await ToolModel.findById(tool.id))?.name).toBe(
      "github__list_issues",
    );
  });
});
