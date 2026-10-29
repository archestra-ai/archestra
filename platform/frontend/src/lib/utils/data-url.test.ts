// @vitest-environment node
import { describe, expect, it } from "vitest";
import { dataUrlToBlob } from "./data-url";

describe("dataUrlToBlob", () => {
  it("preserves base64 attachment bytes and MIME type", async () => {
    const blob = dataUrlToBlob("data:image/png;base64,AAH/");
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 255]),
    );
  });
  it("decodes URL-encoded text attachments", async () => {
    const blob = dataUrlToBlob("data:text/plain,hello%20world%20%E2%9C%93");
    expect(await blob.text()).toBe("hello world ✓");
  });
});
