import { afterEach, beforeEach, describe, vi } from "vitest";
import config from "@/config";
import KbChunkModel from "@/models/kb-chunk";
import { expect, test } from "@/test";
import { bm25Capability } from "./bm25-capability";

describe("bm25Capability", () => {
  beforeEach(() => {
    bm25Capability.reset();
  });

  afterEach(() => {
    bm25Capability.reset();
    vi.restoreAllMocks();
  });

  test("probeBm25Support reports no extension and no index on plain PostgreSQL", async () => {
    const probe = await KbChunkModel.probeBm25Support();
    expect(probe).toEqual({ extensionInstalled: false, indexPresent: false });
  });

  test("is not ready when the flag is off, without touching the database", async () => {
    config.kb.bm25RankingEnabled = false;
    const probeSpy = vi.spyOn(KbChunkModel, "probeBm25Support");
    await expect(bm25Capability.isReady()).resolves.toBe(false);
    expect(probeSpy).not.toHaveBeenCalled();
  });

  test("probes once and caches a definite negative verdict", async () => {
    config.kb.bm25RankingEnabled = true;
    const probeSpy = vi.spyOn(KbChunkModel, "probeBm25Support");
    await expect(bm25Capability.isReady()).resolves.toBe(false);
    await expect(bm25Capability.isReady()).resolves.toBe(false);
    expect(probeSpy).toHaveBeenCalledTimes(1);
  });

  test("reset() forces a re-probe", async () => {
    config.kb.bm25RankingEnabled = true;
    const probeSpy = vi.spyOn(KbChunkModel, "probeBm25Support");
    await bm25Capability.isReady();
    bm25Capability.reset();
    await bm25Capability.isReady();
    expect(probeSpy).toHaveBeenCalledTimes(2);
  });

  test("a probe error is not cached: the next query re-probes", async () => {
    config.kb.bm25RankingEnabled = true;
    const probeSpy = vi
      .spyOn(KbChunkModel, "probeBm25Support")
      .mockRejectedValueOnce(new Error("connection refused"));
    await expect(bm25Capability.isReady()).resolves.toBe(false);
    await expect(bm25Capability.isReady()).resolves.toBe(false);
    expect(probeSpy).toHaveBeenCalledTimes(2);
  });

  test("is ready when the extension and index are both present", async () => {
    config.kb.bm25RankingEnabled = true;
    vi.spyOn(KbChunkModel, "probeBm25Support").mockResolvedValue({
      extensionInstalled: true,
      indexPresent: true,
    });
    await expect(bm25Capability.isReady()).resolves.toBe(true);
  });

  test("extension without the index stays on ts_rank", async () => {
    config.kb.bm25RankingEnabled = true;
    vi.spyOn(KbChunkModel, "probeBm25Support").mockResolvedValue({
      extensionInstalled: true,
      indexPresent: false,
    });
    await expect(bm25Capability.isReady()).resolves.toBe(false);
  });
});
