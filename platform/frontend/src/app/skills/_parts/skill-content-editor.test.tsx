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
  manifest: initialManifest = MANIFEST,
  onFiles,
}: {
  files: ResourceFile[];
  /** Null lists only the files, as a plugin's payload does. */
  manifest?: string | null;
  onFiles?: (files: ResourceFile[]) => void;
}) {
  const [manifest, setManifest] = useState<string | null>(initialManifest);
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

  it("warns that a name outside the Agent Skills spec cannot go over MCP", () => {
    const { rerender } = render(<Harness files={[]} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    rerender(
      <Harness
        key="non-compliant"
        files={[]}
        manifest={
          '---\nname: "Release Checklist"\ndescription: Ship it.\n---\n'
        }
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Not publishable over MCP",
    );
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

  it("refuses a name the server would not store, and keeps it open to correct", async () => {
    const user = userEvent.setup();
    const onFiles = vi.fn();
    render(
      <Harness
        files={[{ path: "notes.md", content: "", encoding: "utf8" }]}
        onFiles={onFiles}
      />,
    );
    const name = () => screen.getByRole("textbox", { name: "File name" });

    await user.click(screen.getByRole("button", { name: "New file" }));
    await user.type(name(), "../up.txt{Enter}");
    expect(
      screen.getByText("A path cannot contain . or .. as a folder name."),
    ).toBeVisible();

    // A second manifest, in any letter case.
    await user.clear(name());
    await user.type(name(), "skill.md{Enter}");
    expect(screen.getByText("SKILL.md is already in the list.")).toBeVisible();

    // A name that is taken says so; it used to do nothing at all.
    await user.clear(name());
    await user.type(name(), "Notes.md{Enter}");
    expect(
      screen.getByText("A file with this name already exists."),
    ).toBeVisible();
    expect(onFiles).not.toHaveBeenCalled();

    // Corrected in place: the message goes with the next keystroke.
    await user.clear(name());
    await user.type(name(), "more-notes.md{Enter}");
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
    expect(onFiles).toHaveBeenLastCalledWith([
      { path: "notes.md", content: "", encoding: "utf8" },
      { path: "more-notes.md", content: "", encoding: "utf8" },
    ]);
  });

  it("opens another file when the open one goes to the trash", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        manifest={null}
        files={[
          { path: "a.md", content: "first", encoding: "utf8" },
          { path: "b.md", content: "second", encoding: "utf8" },
        ]}
      />,
    );
    expect(editor()).toHaveValue("first");

    await user.click(
      screen.getByRole("button", { name: "Move a.md to trash" }),
    );

    expect(editor()).toHaveValue("second");
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
