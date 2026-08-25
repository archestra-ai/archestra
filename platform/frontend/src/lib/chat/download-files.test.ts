// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationStorageKeys } from "@/lib/chat/chat-utils";
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("downloadFiles", () => {
  it("starts one download per file, with the right href and filename", async () => {
    const hrefs: string[] = [];
    const downloads: string[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        hrefs.push(this.getAttribute("href") ?? "");
        downloads.push(this.getAttribute("download") ?? "");
      });

    const started = await downloadFiles([
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

  it("skips files without a byte endpoint (e.g. the in-memory artifact)", async () => {
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const started = await downloadFiles([
      { name: "artifact.md", contentUrl: "" },
    ]);

    expect(started).toBe(0);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("cleans up the temporary anchors it creates", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await downloadFiles([item("a", "/x"), item("b", "/y")]);
    expect(document.body.querySelector("a")).toBeNull();
  });

  it("downloads a locked chat's attachment through its conversation key", async () => {
    // An anchor cannot send the key header, so a bare href would download the
    // endpoint's 400 body under the file's name. The bytes are fetched first
    // and handed over as a blob instead.
    const conversationId = "3f1c2d0e-0000-4000-8000-000000000001";
    localStorage.setItem(
      conversationStorageKeys(conversationId).lockedChatKey,
      "a".repeat(43),
    );
    // A hand-rolled response, not `new Response(new Blob(...))`: jsdom's Blob
    // is not the one undici's Response knows how to read.
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["sealed"]),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    // jsdom implements neither, so these are defined rather than spied.
    URL.createObjectURL = vi.fn(() => "blob:demo");
    URL.revokeObjectURL = vi.fn();
    const hrefs: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      hrefs.push(this.getAttribute("href") ?? "");
    });

    const started = await downloadFiles(
      [item("b", "/api/chat/attachments/b/content")],
      conversationId,
    );

    expect(started).toBe(1);
    expect(hrefs).toEqual(["blob:demo"]);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/chat/attachments/b/content",
      expect.objectContaining({
        headers: { "x-archestra-locked-chat-key": "a".repeat(43) },
      }),
    );
  });

  it("skips a sealed attachment this browser cannot open", async () => {
    // Better to leave it out than to save the endpoint's error body as a file.
    const conversationId = "3f1c2d0e-0000-4000-8000-000000000002";
    localStorage.setItem(
      conversationStorageKeys(conversationId).lockedChatKey,
      "b".repeat(43),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 400 })),
    );
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const started = await downloadFiles(
      [item("b", "/api/chat/attachments/b/content")],
      conversationId,
    );

    expect(started).toBe(0);
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
