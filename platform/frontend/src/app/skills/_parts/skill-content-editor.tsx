"use client";

import { DocsPage, isSpecCompliantSkillName } from "@archestra/shared";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Lock,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Editor } from "@/components/editor";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { parseManifestFields } from "@/lib/skills/manifest-compose";
import { formatBytes } from "@/lib/skills-sandbox/sandbox-file-preview";
import { cn } from "@/lib/utils";
import type { ResourceFile } from "./skill-draft";

interface FolderEntry {
  file: ResourceFile;
  index: number;
}

interface TrashedFile {
  id: string;
  file: ResourceFile;
}

let trashIdCounter = 0;
const nextTrashId = () => `trash-${++trashIdCounter}`;

const MANIFEST_PLACEHOLDER = `---
name: my-skill
description: One line on when an agent should use this skill.
---

# My Skill

Step-by-step instructions for the agent...`;

const ROOT_ADD_KEY = "";

/** Shared height contract for full-page skill content editors. */
export const SKILL_PAGE_EDITOR_CLASS =
  "h-[calc(100vh-26rem)] min-h-[28rem] shrink-0";

/**
 * The content half of a skill: SKILL.md manifest plus resource files, as a
 * file tree beside a text editor. Controlled — the manifest and file set live
 * in the caller's draft; only view state (open file, collapsed folders, the
 * session trash bin) is kept here, so it resets whenever the pane unmounts.
 */
export function SkillContentEditor({
  manifest,
  files,
  onManifestChange,
  onFilesChange,
  readOnly = false,
  readOnlyMarker = true,
  className,
}: {
  manifest: string;
  files: ResourceFile[];
  onManifestChange: (manifest: string) => void;
  onFilesChange: (update: (files: ResourceFile[]) => ResourceFile[]) => void;
  /** Locks the manifest and files (a preview, or a GitHub-synced skill). */
  readOnly?: boolean;
  /**
   * Whether a locked editor says so beside the file name. Off where the host
   * already does — a preview of a skill not yet imported, the skill's own
   * read-only page — so the marker does not repeat it.
   */
  readOnlyMarker?: boolean;
  className?: string;
}) {
  const [openFileIndex, setOpenFileIndex] = useState<number | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  // null = not adding; "" = adding at root; otherwise the folder name.
  const [addingIn, setAddingIn] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState("");
  // empty folders that exist only in this session — they only persist once a file is dropped in.
  const [pendingFolders, setPendingFolders] = useState<string[]>([]);
  const [addingNewFolder, setAddingNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // soft-deleted files held in a trash bin for as long as this pane is open;
  // restorable until then.
  const [trash, setTrash] = useState<TrashedFile[]>([]);
  const [trashExpanded, setTrashExpanded] = useState(true);

  const parsed = useMemo(() => parseManifestFields(manifest), [manifest]);

  const tree = useMemo(
    () => buildTree(files, pendingFolders),
    [files, pendingFolders],
  );

  const commitNewFile = (folder: string | null) => {
    const name = newFileName.trim();
    if (!name) return;
    const path = folder ? `${folder}/${name}` : name;
    if (files.some((f) => f.path === path)) return;
    onFilesChange((prev) => [...prev, { path, content: "", encoding: "utf8" }]);
    setOpenFileIndex(files.length);
    setNewFileName("");
    setAddingIn(null);
  };

  const cancelAdding = () => {
    setAddingIn(null);
    setNewFileName("");
  };

  const commitNewFolder = () => {
    const name = newFolderName.trim().replace(/\/+$/, "");
    if (!name || name.includes("/")) return;
    const fileFolderNames = new Set(
      files
        .map((f) => f.path.slice(0, f.path.indexOf("/")))
        .filter((f) => f.length > 0),
    );
    if (!fileFolderNames.has(name) && !pendingFolders.includes(name)) {
      setPendingFolders((prev) => [...prev, name]);
    }
    setAddingNewFolder(false);
    setNewFolderName("");
    setAddingIn(name);
    setNewFileName("");
  };

  const cancelAddingFolder = () => {
    setAddingNewFolder(false);
    setNewFolderName("");
  };

  const removeFile = (index: number) => {
    const removed = files[index];
    if (removed) {
      setTrash((prev) => [...prev, { id: nextTrashId(), file: removed }]);
      setTrashExpanded(true);
    }
    onFilesChange((prev) => prev.filter((_, i) => i !== index));
    setOpenFileIndex((current) => {
      if (current === index) return null;
      if (current !== null && current > index) return current - 1;
      return current;
    });
  };

  const removeFolder = (folder: string) => {
    const prefix = `${folder}/`;
    let openWasInFolder = false;
    if (openFileIndex !== null) {
      const openPath = files[openFileIndex]?.path;
      if (openPath?.startsWith(prefix)) openWasInFolder = true;
    }
    const removed = files.filter((f) => f.path.startsWith(prefix));
    if (removed.length > 0) {
      setTrash((prev) => [
        ...prev,
        ...removed.map((file) => ({ id: nextTrashId(), file })),
      ]);
      setTrashExpanded(true);
    }
    onFilesChange((prev) => prev.filter((f) => !f.path.startsWith(prefix)));
    setPendingFolders((prev) => prev.filter((f) => f !== folder));
    if (openWasInFolder) setOpenFileIndex(null);
  };

  const restoreFile = (id: string) => {
    const item = trash.find((t) => t.id === id);
    if (!item) return;
    setTrash((prev) => prev.filter((t) => t.id !== id));
    if (files.some((f) => f.path === item.file.path)) return;
    onFilesChange((prev) => [...prev, item.file]);
  };

  const permanentRemoveFile = (id: string) => {
    setTrash((prev) => prev.filter((t) => t.id !== id));
  };

  const toggleFolder = (folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
  };

  const beginAddingInFolder = (folder: string) => {
    setCollapsedFolders((prev) => {
      if (!prev.has(folder)) return prev;
      const next = new Set(prev);
      next.delete(folder);
      return next;
    });
    setAddingIn(folder);
    setNewFileName("");
  };

  const openFile = openFileIndex === null ? null : files[openFileIndex];
  const editorValue = openFile ? openFile.content : manifest;
  const setEditorValue = (value: string) => {
    if (openFileIndex === null) {
      onManifestChange(value);
    } else {
      onFilesChange((prev) =>
        prev.map((file, i) =>
          i === openFileIndex ? { ...file, content: value } : file,
        ),
      );
    }
  };

  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(8rem,auto)_minmax(20rem,1fr)] gap-3 overflow-y-auto md:grid-cols-[240px_1fr] md:grid-rows-1 md:overflow-hidden",
        className,
      )}
    >
      <div className="flex max-h-48 min-h-0 flex-col rounded-md border md:max-h-none">
        <div className="flex-1 overflow-y-auto p-2">
          <ul className="space-y-0.5">
            <ManifestRow
              isOpen={openFileIndex === null}
              onOpen={() => setOpenFileIndex(null)}
            />

            {tree.folderNames.map((folder) => {
              const isCollapsed = collapsedFolders.has(folder);
              const entries = tree.folders[folder];
              return (
                <li key={folder}>
                  <FolderRow
                    folder={folder}
                    fileCount={entries.length}
                    isCollapsed={isCollapsed}
                    readOnly={readOnly}
                    onToggle={() => toggleFolder(folder)}
                    onAddFile={() => beginAddingInFolder(folder)}
                    onRemoveFolder={() => removeFolder(folder)}
                  />
                  {!isCollapsed && (
                    <ul className="ml-5 space-y-0.5 border-l pl-2">
                      {entries.map(({ file, index }) => (
                        <FileRow
                          key={file.path}
                          label={file.path.slice(folder.length + 1)}
                          isOpen={openFileIndex === index}
                          readOnly={readOnly}
                          onOpen={() => setOpenFileIndex(index)}
                          onRemove={() => removeFile(index)}
                        />
                      ))}
                      {addingIn === folder && (
                        <NewFileRow
                          placeholder="filename.md"
                          value={newFileName}
                          onChange={setNewFileName}
                          onCommit={() => commitNewFile(folder)}
                          onCancel={cancelAdding}
                        />
                      )}
                    </ul>
                  )}
                </li>
              );
            })}

            {tree.rootFiles.map(({ file, index }) => (
              <FileRow
                key={file.path}
                label={file.path}
                isOpen={openFileIndex === index}
                readOnly={readOnly}
                onOpen={() => setOpenFileIndex(index)}
                onRemove={() => removeFile(index)}
              />
            ))}

            {addingIn === ROOT_ADD_KEY && (
              <NewFileRow
                placeholder="new-file.md or folder/new-file.md"
                value={newFileName}
                onChange={setNewFileName}
                onCommit={() => commitNewFile(null)}
                onCancel={cancelAdding}
              />
            )}
          </ul>
        </div>

        {!readOnly && trash.length > 0 && (
          <div className="border-t">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setTrashExpanded((v) => !v)}
            >
              {trashExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              )}
              <Trash2 className="h-3.5 w-3.5 shrink-0" />
              <span>Trash ({trash.length})</span>
            </button>
            {trashExpanded && (
              <ul className="space-y-0.5 px-2 pb-2">
                {trash.map(({ id, file }) => (
                  <TrashRow
                    key={id}
                    path={file.path}
                    onRestore={() => restoreFile(id)}
                    onPurge={() => permanentRemoveFile(id)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}

        {!readOnly && addingNewFolder && (
          <div className="border-t p-2">
            <NewFolderRow
              value={newFolderName}
              onChange={setNewFolderName}
              onCommit={commitNewFolder}
              onCancel={cancelAddingFolder}
            />
          </div>
        )}

        {!readOnly && addingIn === null && !addingNewFolder && (
          <div className="flex items-center gap-3 border-t p-2">
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setAddingIn(ROOT_ADD_KEY);
                setNewFileName("");
              }}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span>New file</span>
            </button>
            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                setAddingNewFolder(true);
                setNewFolderName("");
              }}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span>New folder</span>
            </button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Label className="font-mono text-xs">
              {openFile ? openFile.path : "SKILL.md"}
            </Label>
            {readOnly && readOnlyMarker && (
              <span className="inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                <Lock className="size-3" />
                Read-only
              </span>
            )}
          </div>
          {!openFile && !readOnly && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help text-xs text-muted-foreground">
                  frontmatter: name <Marker ok={parsed.hasName} /> · description{" "}
                  <Marker ok={parsed.hasDescription} />
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                <code className="font-mono">name</code> and{" "}
                <code className="font-mono">description</code> must be set in
                the YAML frontmatter block (between the{" "}
                <code className="font-mono">---</code> fences) at the top of{" "}
                <code className="font-mono">SKILL.md</code>. Agents read these
                to decide when to use the skill.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {!openFile &&
          parsed.name !== null &&
          !isSpecCompliantSkillName(parsed.name) && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              This name cannot be published over MCP: the Agent Skills
              specification allows only lowercase letters, digits, and single
              hyphens (max 64 characters). The skill still works everywhere
              else.
            </p>
          )}
        {openFile && openFile.encoding === "base64" ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 rounded-md border bg-muted/30 text-center text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Binary asset</span>
            <span className="text-xs">
              {formatBytes(approxBase64Bytes(openFile.content))} · base64
              encoded
            </span>
            <span className="max-w-xs text-xs">
              Stored verbatim for redistribution. Not editable here.
            </span>
          </div>
        ) : (
          // The same embedded editor the MCP server's deployment YAML uses:
          // language by file name, so SKILL.md gets Markdown and a bundled
          // script its own highlighting.
          <div
            className={cn(
              "min-h-0 flex-1 overflow-hidden rounded-md border",
              readOnly && "bg-muted/40",
            )}
          >
            <Editor
              height="100%"
              // Keyed by the open file, so Monaco swaps models instead of
              // carrying one file's undo stack and language into the next.
              key={openFile ? openFile.path : "SKILL.md"}
              language={editorLanguage(openFile ? openFile.path : "SKILL.md")}
              value={editorValue}
              onChange={(value) => setEditorValue(value ?? "")}
              loading={
                <div className="flex h-full w-full items-center justify-center bg-muted/50">
                  <p className="text-sm text-muted-foreground">
                    Loading editor...
                  </p>
                </div>
              }
              options={{
                ariaLabel: "File contents",
                placeholder: openFile
                  ? "File contents..."
                  : MANIFEST_PLACEHOLDER,
                readOnly,
                minimap: { enabled: false },
                lineNumbers: "on",
                folding: true,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                fontSize: 13,
                fontFamily: "monospace",
                tabSize: 2,
                padding: { top: 8, bottom: 8 },
                renderLineHighlight: "line",
                scrollbar: {
                  vertical: "auto",
                  horizontal: "auto",
                  verticalScrollbarSize: 10,
                  // The pane sits in a page that scrolls: a wheel that
                  // reaches the editor's edge keeps scrolling the page.
                  alwaysConsumeMouseWheel: false,
                },
              }}
            />
          </div>
        )}
        {!openFile && parsed.templated && <TemplatedManifestHint />}
      </div>
    </div>
  );
}

function ManifestRow({
  isOpen,
  onOpen,
}: {
  isOpen: boolean;
  onOpen: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded px-2 py-1",
        isOpen ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      <FileText className="h-4 w-4 shrink-0 text-foreground" />
      <button
        type="button"
        className="flex-1 truncate text-left font-mono text-xs font-medium"
        onClick={onOpen}
      >
        SKILL.md
      </button>
      <span className="text-xs text-muted-foreground">manifest</span>
    </li>
  );
}

function FolderRow({
  folder,
  fileCount,
  isCollapsed,
  readOnly,
  onToggle,
  onAddFile,
  onRemoveFolder,
}: {
  folder: string;
  fileCount: number;
  isCollapsed: boolean;
  readOnly: boolean;
  onToggle: () => void;
  onAddFile: () => void;
  onRemoveFolder: () => void;
}) {
  return (
    <div className="group flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/50">
      <button
        type="button"
        className="flex flex-1 items-center gap-1.5 text-left"
        onClick={onToggle}
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        {isCollapsed ? (
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-sm font-medium">{folder}/</span>
        {isCollapsed && (
          <span className="text-xs text-muted-foreground">({fileCount})</span>
        )}
      </button>
      {!readOnly && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100"
            onClick={onAddFile}
            title={`Add file in ${folder}/`}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100"
            onClick={onRemoveFolder}
            title={`Move folder ${folder}/ to trash`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

function FileRow({
  label,
  isOpen,
  readOnly,
  onOpen,
  onRemove,
}: {
  label: string;
  isOpen: boolean;
  readOnly: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <li
      className={cn(
        "group flex items-center gap-2 rounded px-2 py-1",
        isOpen ? "bg-muted" : "hover:bg-muted/50",
      )}
    >
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <button
        type="button"
        className="flex-1 truncate text-left font-mono text-xs"
        onClick={onOpen}
      >
        {label}
      </button>
      {!readOnly && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100"
          onClick={onRemove}
          title="Move to trash"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </li>
  );
}

function NewFileRow({
  placeholder,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <li className="flex items-center gap-2 px-2 py-1">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <Input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
        placeholder={placeholder}
        className="h-7 flex-1 font-mono text-xs"
        aria-label="File name"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={onCommit}
        disabled={!value.trim()}
      >
        Add
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onCancel}
        aria-label="Cancel"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

function TrashRow({
  path,
  onRestore,
  onPurge,
}: {
  path: string;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <li className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/50">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate font-mono text-xs text-muted-foreground line-through">
        {path}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 opacity-0 group-hover:opacity-100"
        onClick={onRestore}
        title="Restore"
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 opacity-0 group-hover:opacity-100"
        onClick={onPurge}
        title="Delete permanently"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

function NewFolderRow({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-1">
      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
      <Input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          } else if (e.key === "Escape") {
            onCancel();
          }
        }}
        placeholder="folder name"
        className="h-7 flex-1 font-mono text-xs"
        aria-label="Folder name"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={onCommit}
        disabled={!value.trim() || value.includes("/")}
      >
        Add
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onCancel}
        aria-label="Cancel"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function Marker({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? "text-emerald-600" : "text-muted-foreground"}>
      {ok ? "✓" : "—"}
    </span>
  );
}

function approxBase64Bytes(content: string): number {
  // Each 4 chars of base64 encodes 3 bytes; ignore padding for a rough estimate.
  return Math.floor((content.length * 3) / 4);
}

function buildTree(
  files: ResourceFile[],
  pendingFolders: string[],
): {
  folders: Record<string, FolderEntry[]>;
  folderNames: string[];
  rootFiles: FolderEntry[];
} {
  const folders: Record<string, FolderEntry[]> = {};
  for (const folder of pendingFolders) {
    folders[folder] = [];
  }
  const rootFiles: FolderEntry[] = [];
  files.forEach((file, index) => {
    const slashIdx = file.path.indexOf("/");
    if (slashIdx === -1) {
      rootFiles.push({ file, index });
    } else {
      const folder = file.path.slice(0, slashIdx);
      if (!folders[folder]) folders[folder] = [];
      folders[folder].push({ file, index });
    }
  });
  return { folders, folderNames: Object.keys(folders).sort(), rootFiles };
}

/** Shown when the manifest declares `templated: true`, mirroring the agent
 * system-prompt hint: the body is rendered with Handlebars at activation. */
function TemplatedManifestHint() {
  const docsUrl = getFrontendDocsUrl(
    DocsPage.PlatformAgents,
    "system-prompt-templating",
  );
  return (
    <p className="text-xs text-muted-foreground">
      Templated skill — the body is rendered with{" "}
      <a
        href="https://handlebarsjs.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        Handlebars
      </a>{" "}
      (e.g. <code className="font-mono">{"{{user.name}}"}</code>) at activation
      {docsUrl ? (
        <>
          {" "}
          — see{" "}
          <ExternalDocsLink
            href={docsUrl}
            className="underline hover:text-foreground"
            showIcon={false}
          >
            docs
          </ExternalDocsLink>{" "}
          for available variables.
        </>
      ) : (
        <span>.</span>
      )}
    </p>
  );
}

/** Monaco's language id for a skill file, from its extension; plain text otherwise. */
function editorLanguage(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return EDITOR_LANGUAGES[extension] ?? "plaintext";
}

const EDITOR_LANGUAGES: Record<string, string> = {
  md: "markdown",
  markdown: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  jsx: "javascript",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  toml: "ini",
  ini: "ini",
  html: "html",
  css: "css",
  sql: "sql",
  xml: "xml",
  txt: "plaintext",
};
