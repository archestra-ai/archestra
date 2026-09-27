import { describe, expect, it, vi } from "vitest";
import type { FolderTraversalAdapter } from "./folder-traversal";
import { traverseFolders } from "./folder-traversal";

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const results: string[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

describe("traverseFolders", () => {
  it("yields the root folder when there are no subfolders", async () => {
    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: async () => [],
    };
    const result = await collect(
      traverseFolders(adapter, { rootFolderId: "root" }),
    );
    expect(result).toEqual(["root"]);
  });

  it("yields root then direct children in BFS order", async () => {
    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: async (id) => {
        if (id === "root") return ["a", "b"];
        return [];
      },
    };
    const result = await collect(
      traverseFolders(adapter, { rootFolderId: "root" }),
    );
    expect(result).toEqual(["root", "a", "b"]);
  });

  it("traverses nested subfolders in BFS order", async () => {
    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: async (id) => {
        if (id === "root") return ["a", "b"];
        if (id === "a") return ["a1", "a2"];
        if (id === "b") return ["b1"];
        return [];
      },
    };
    const result = await collect(
      traverseFolders(adapter, { rootFolderId: "root" }),
    );
    expect(result).toEqual(["root", "a", "b", "a1", "a2", "b1"]);
  });

  it("does not descend into subfolders when recursive is false", async () => {
    const listDirectSubfolders = vi
      .fn()
      .mockResolvedValue(["child1", "child2"]);
    const adapter: FolderTraversalAdapter = { listDirectSubfolders };
    const result = await collect(
      traverseFolders(adapter, { rootFolderId: "root", recursive: false }),
    );
    expect(result).toEqual(["root"]);
    expect(listDirectSubfolders).not.toHaveBeenCalled();
  });

  it("respects maxDepth and does not descend beyond it", async () => {
    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: async (id) => [`${id}-child`],
    };
    const result = await collect(
      traverseFolders(adapter, { rootFolderId: "root", maxDepth: 2 }),
    );
    expect(result).toEqual(["root", "root-child", "root-child-child"]);
  });

  it("logs debug message when max depth is reached", async () => {
    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: async (id) => [`${id}-child`],
    };
    const log = { debug: vi.fn(), warn: vi.fn() };
    await collect(
      traverseFolders(adapter, { rootFolderId: "root", maxDepth: 1 }, log),
    );
    expect(log.debug).toHaveBeenCalledWith(
      expect.objectContaining({ depth: 1, maxDepth: 1 }),
      "Max depth reached, not descending further",
    );
  });

  it("continues traversal when listDirectSubfolders throws for one branch", async () => {
    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: async (id) => {
        if (id === "root") return ["good", "bad"];
        if (id === "bad") throw new Error("Permission denied");
        if (id === "good") return ["good-child"];
        return [];
      },
    };
    const result = await collect(
      traverseFolders(adapter, { rootFolderId: "root" }),
    );
    expect(result).toContain("root");
    expect(result).toContain("good");
    expect(result).toContain("bad");
    expect(result).toContain("good-child");
  });

  it("logs a warning when a subfolder listing fails", async () => {
    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: async (id) => {
        if (id === "root") return ["failing"];
        throw new Error("Network error");
      },
    };
    const log = { debug: vi.fn(), warn: vi.fn() };
    await collect(traverseFolders(adapter, { rootFolderId: "root" }, log));
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Network error" }),
      "Failed to list subfolders, skipping branch",
    );
  });

  it("yields only root when root has no subfolders and recursive is true", async () => {
    const adapter: FolderTraversalAdapter = {
      listDirectSubfolders: async () => [],
    };
    const result = await collect(
      traverseFolders(adapter, { rootFolderId: "/team-docs", recursive: true }),
    );
    expect(result).toEqual(["/team-docs"]);
  });
});
