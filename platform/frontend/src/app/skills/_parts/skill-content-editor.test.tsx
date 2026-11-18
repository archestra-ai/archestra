import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillContentEditor } from "./skill-content-editor";
import type { ResourceFile } from "./skill-draft";

vi.mock("@/components/editor");

const MANIFEST = "---\nname: release-checklist\ndescription: Ship it.\n---\n";

/** The editor as a page holds it: content in the caller's state. */
function Harness({
  files: initial,
  onFiles,
}: {
  files: ResourceFile[];
  onFiles?: (files: ResourceFile[]) => void;
}) {
  const [manifest, setManifest] = useState(MANIFEST);
  const [files, setFiles] = useState(initial);
  return (
    <SkillContentEditor
      manifest={manifest}
      files={files}
      onManifestChange={setManifest}
      onFilesChange={(update) =>
        setFiles((current) => {
          const next = update(current);
          onFiles?.(next);
          return next;
        })
      }
    />
  );
}

const explorer = () => screen.getByRole("navigation", { name: "Files" });
const editor = () => screen.getByRole("textbox", { name: "File contents" });

describe("SkillContentEditor", () => {
  beforeEach(() => {
    // jsdom has no layout; the palette scrolls its selected row into view.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("opens the manifest first and another file from the explorer", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        files={[
          { path: "scripts/run.py", content: "print(1)", encoding: "utf8" },
        ]}
      />,
    );

    expect(editor()).toHaveValue(MANIFEST);
    await user.click(
      within(explorer()).getByRole("button", { name: "run.py" }),
    );
    expect(editor()).toHaveValue("print(1)");
    expect(editor()).toHaveAttribute("data-language", "python");
  });

  it("names a new folder's first file and opens it", async () => {
    const user = userEvent.setup();
    const onFiles = vi.fn();
    render(<Harness files={[]} onFiles={onFiles} />);

    await user.click(screen.getByRole("button", { name: "New folder" }));
    await user.type(
      screen.getByRole("textbox", { name: "Folder name" }),
      "references{Enter}",
    );
    await user.type(
      screen.getByRole("textbox", { name: "File name" }),
      "api.md{Enter}",
    );

    expect(onFiles).toHaveBeenLastCalledWith([
      { path: "references/api.md", content: "", encoding: "utf8" },
    ]);
    expect(
      within(explorer()).getByRole("button", { name: "api.md" }),
    ).toHaveAttribute("aria-current", "page");
    expect(editor()).toHaveValue("");
  });

  it("moves a file to the trash and restores it", async () => {
    const user = userEvent.setup();
    const onFiles = vi.fn();
    const file: ResourceFile = {
      path: "notes.md",
      content: "keep",
      encoding: "utf8",
    };
    render(<Harness files={[file]} onFiles={onFiles} />);

    await user.click(
      screen.getByRole("button", { name: "Move notes.md to trash" }),
    );
    expect(onFiles).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole("button", { name: /^Trash\s*1$/ })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Restore notes.md" }));
    expect(onFiles).toHaveBeenLastCalledWith([file]);
    expect(
      screen.queryByRole("button", { name: /^Trash/ }),
    ).not.toBeInTheDocument();
  });

  it("jumps to a file from the palette that Cmd+P opens", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        files={[
          { path: "a/deep/path/config.json", content: "{}", encoding: "utf8" },
        ]}
      />,
    );

    await user.click(editor());
    await user.keyboard("{Meta>}p{/Meta}");
    const palette = screen.getByRole("dialog", { name: "Open a file" });
    await user.type(within(palette).getByRole("combobox"), "config");
    await user.click(within(palette).getByRole("option", { name: /config/ }));

    expect(editor()).toHaveValue("{}");
  });
});
