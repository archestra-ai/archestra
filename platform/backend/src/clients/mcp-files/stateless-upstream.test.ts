import { MCP_FILES_EXTENSION_ID } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { parseFilesSupport } from "./stateless-upstream";

const discover = (settings: unknown, versions = ["2026-07-28"]) => ({
  supportedVersions: versions,
  capabilities: { extensions: { [MCP_FILES_EXTENSION_ID]: settings } },
});

describe("parseFilesSupport", () => {
  test("reads upload and the inline limit", () => {
    expect(
      parseFilesSupport(discover({ upload: {}, maxInlineBytes: 1024 })),
    ).toEqual({
      upload: true,
      maxInlineBytes: 1024,
    });
    expect(parseFilesSupport(discover({}))).toEqual({
      upload: false,
      maxInlineBytes: 0,
    });
  });

  test("an unknown revision, a missing extension or an older server means no support", () => {
    const none = { upload: false, maxInlineBytes: 0 };
    expect(parseFilesSupport(discover({ upload: {}, revision: "2" }))).toEqual(
      none,
    );
    expect(parseFilesSupport(discover(undefined))).toEqual(none);
    expect(parseFilesSupport(discover({ upload: {} }, ["2025-11-25"]))).toEqual(
      none,
    );
    expect(parseFilesSupport({})).toEqual(none);
  });
});
