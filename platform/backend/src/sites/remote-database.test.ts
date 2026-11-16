import { afterEach, vi } from "vitest";
import config from "@/config";
import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { writeAfterResponse } from "./remote-database";

describe("writeAfterResponse", () => {
  afterEach(() => {
    config.site.remoteDatabase = false;
    vi.useRealTimers();
  });

  test("a site next to its database writes before it returns", async () => {
    const write = vi.fn(async () => {});
    const { written } = await writeAfterResponse("test", write);
    expect(write).toHaveBeenCalledTimes(1);
    await expect(written).resolves.toBeUndefined();
  });

  test("a site far from its database returns first and retries a failed write", async () => {
    config.site.remoteDatabase = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        await gate;
        throw new Error("connection reset");
      })
      .mockResolvedValueOnce(undefined);

    const { written } = await writeAfterResponse("test", write);
    expect(write).toHaveBeenCalledTimes(1);
    release();
    await written;
    expect(write).toHaveBeenCalledTimes(2);
    await drainBackgroundWork();
  });
});
