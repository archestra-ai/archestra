import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type VersionFile, VersionFiles } from "./version-files";

const script = (mode: string) => ({
  content: "echo hi\n",
  encoding: "utf8" as const,
  mode,
});

describe("VersionFiles", () => {
  it("says that only a file's mode changed, in place of an empty diff", () => {
    const files: VersionFile[] = [
      {
        path: "scripts/run.sh",
        change: "changed",
        current: script("100755"),
        previous: script("100644"),
        language: "shell",
      },
    ];

    render(<VersionFiles files={files} mode="changes" />);

    expect(
      screen.getByText(
        "The file's mode changed from 100644 to 100755, which makes it executable. Its content is the same.",
      ),
    ).toBeVisible();
  });
});
