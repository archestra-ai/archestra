// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationFileItem } from "@/lib/chat/conversation-files";
import { downloadFiles } from "@/lib/chat/download-files";

function item(id: string, contentUrl: string): ConversationFileItem {
  return {
    id,
    name: `${id}.bin`,
    mimeType: "application/octet-stream",
    contentUrl,
    source: "generated",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("downloadFiles", () => {
  it("starts one download per file, with the right href and filename", () => {
    const hrefs: string[] = [];
    const downloads: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        hrefs.push(this.getAttribute("href") ?? "");
        downloads.push(this.getAttribute("download") ?? "");
      });

    const started = downloadFiles([
      item("a", "/api/skill-sandbox/artifacts/a"),
      item("b", "/api/chat/attachments/b/content"),
    ]);

    expect(started).toBe(2);
    expect(clickSpy).toHaveBeenCalledTimes(2);
    expect(hrefs).toEqual([
      "/api/skill-sandbox/artifacts/a",
      "/api/chat/attachments/b/content",
    ]);
    expect(downloads).toEqual(["a.bin", "b.bin"]);
  });

  it("skips files without a byte endpoint (e.g. the in-memory artifact)", () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const started = downloadFiles([{ name: "artifact.md", contentUrl: "" }]);

    expect(started).toBe(0);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("cleans up the temporary anchors it creates", () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    downloadFiles([item("a", "/x"), item("b", "/y")]);
    expect(document.body.querySelector("a")).toBeNull();
  });
});
