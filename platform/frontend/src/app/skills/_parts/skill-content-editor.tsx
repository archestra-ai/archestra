"use client";

import { DocsPage, isSpecCompliantSkillName } from "@archestra/shared";
import {
  File,
  FileBraces,
  FileCode2,
  FilePlus,
  FileTerminal,
  FileText,
  Folder,
  FolderPlus,
  LockKeyhole,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import type { WorkspaceDownload } from "@/components/file-workspace/download-zip";
import {
  FILE_ROW_ACTION_CLASS,
  FILE_ROW_CLASS,
  FileExplorer,
  type FileExplorerSection,
  fileRowIndent,
} from "@/components/file-workspace/file-explorer";
import type { WorkspaceFile } from "@/components/file-workspace/file-tree";
import {
  FileKindChip,
  FilePathLabel,
  FileWorkspace,
  FileWorkspaceNotice,
  IconBadge,
} from "@/components/file-workspace/file-workspace";
import { WorkspaceEditor } from "@/components/file-workspace/workspace-editor";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { parseManifestFields } from "@/lib/skills/manifest-compose";
import { formatBytes } from "@/lib/utils/format-bytes";
import { cn } from "@/lib/utils/tailwind";
import type { ResourceFile } from "./skill-draft";

/** Editing viewport with room left for wizard navigation and actions. */
export const SKILL_WIZARD_EDITOR_CLASS =
  "h-[calc(100vh-22rem)] min-h-[28rem] max-h-[64rem] flex-none";

/**
 * A manifest and resource files in the file workspace the Guardrails policy
 * is read in: an explorer of the files' folders beside an editor, one bar on
 * top naming the open file, and Cmd/Ctrl+P to jump to any file. Passing a
 * null manifest lists only the files, for a plugin's payload.
 *
 * Controlled — content lives in the caller's draft; only view state (the open
 * file, a name being typed, empty folders, the session trash bin) is kept here.
 */
export function SkillContentEditor({
  manifest,
  files,
  onManifestChange,
  onFilesChange,
  readOnly = false,
  readOnlyMarker = true,
  downloadName,
  className,
}: {
  manifest: string | null;
  files: ResourceFile[];
  onManifestChange: (manifest: string) => void;
  onFilesChange: (update: (files: ResourceFile[]) => ResourceFile[]) => void;
  /** Locks the manifest and files (a preview, or a GitHub-synced skill). */
  readOnly?: boolean;
  /**
   * Whether a locked editor says so in its bar. Off where the host already
   * does — a preview of a skill not yet imported, the skill's own read-only
   * page — so the marker does not repeat it.
   */
  readOnlyMarker?: boolean;
  /**
   * Names the .zip the bar's download button saves; the manifest's `name`,
   * else "skill" or "plugin", when left out.
   */
  downloadName?: string;
  className?: string;
}) {
  const [openKey, setOpenKey] = useState<string | null>(() =>
    manifest !== null ? MANIFEST_KEY : files[0] ? fileKey(files[0].path) : null,
  );
  // The folder a new file is being named in (null: the top); undefined while
  // no file is being named.
  const [addingFileIn, setAddingFileIn] = useState<string | null | undefined>(
    undefined,
  );
  const [addingFolder, setAddingFolder] = useState(false);
  // Empty folders that exist only in this session: they persist once a file
  // is put in one.
  const [pendingFolders, setPendingFolders] = useState<string[]>([]);
  // Files moved to the trash, restorable for as long as this editor is open.
  const [trash, setTrash] = useState<TrashedFile[]>([]);

  const parsed = useMemo(() => parseManifestFields(manifest ?? ""), [manifest]);

  const items = useMemo<ContentItem[]>(
    () => [
      ...(manifest !== null
        ? [
            {
              key: MANIFEST_KEY,
              path: MANIFEST_PATH,
              name: MANIFEST_PATH,
              kind: "manifest" as const,
            },
          ]
        : []),
      ...files.map((file) => ({
        key: fileKey(file.path),
        path: file.path,
        name: file.path.slice(file.path.lastIndexOf("/") + 1),
        kind: "file" as const,
        file,
      })),
    ],
    [manifest, files],
  );
  const openItem =
    items.find((item) => item.key === openKey) ??
    (manifest !== null ? items[0] : undefined);
  const openFile = openItem?.kind === "file" ? openItem.file : null;
  const manifestOpen = openItem?.kind === "manifest";

  const removeFiles = (paths: Set<string>) => {
    const removed = files.filter((file) => paths.has(file.path));
    if (removed.length === 0) return;
    setTrash((current) => [
      ...current,
      ...removed.map((file) => ({ id: nextTrashId(), file })),
    ]);
    onFilesChange((current) => current.filter((file) => !paths.has(file.path)));
  };
  const removeFolder = (folder: string) => {
    const prefix = `${folder}/`;
    removeFiles(
      new Set(
        files.flatMap((file) =>
          file.path.startsWith(prefix) ? [file.path] : [],
        ),
      ),
    );
    setPendingFolders((current) =>
      current.filter((path) => path !== folder && !path.startsWith(prefix)),
    );
  };
  const restore = (id: string) => {
    const item = trash.find((entry) => entry.id === id);
    if (!item) return;
    setTrash((current) => current.filter((entry) => entry.id !== id));
    if (files.some((file) => file.path === item.file.path)) return;
    onFilesChange((current) => [...current, item.file]);
  };
  const commitNewFile = (folder: string | null, name: string) => {
    const path = folder ? `${folder}/${name}` : name;
    if (files.some((file) => file.path === path)) return;
    onFilesChange((current) => [
      ...current,
      { path, content: "", encoding: "utf8" },
    ]);
    setOpenKey(fileKey(path));
    setAddingFileIn(undefined);
  };
  const commitNewFolder = (name: string) => {
    if (name.includes("/")) return;
    if (!pendingFolders.includes(name)) {
      setPendingFolders((current) => [...current, name]);
    }
    setAddingFolder(false);
    // A folder exists once it holds a file: name its first one now.
    setAddingFileIn(name);
  };
  const setEditorValue = (value: string) => {
    if (manifestOpen) onManifestChange(value);
    else if (openFile)
      onFilesChange((current) =>
        current.map((file) =>
          file.path === openFile.path ? { ...file, content: value } : file,
        ),
      );
  };

  const sections: FileExplorerSection<ExplorerItem>[] = [
    {
      id: "files",
      title: "Files",
      count: items.length,
      files: items,
      folders: pendingFolders,
      empty: <p>No files yet.</p>,
      actions: readOnly ? undefined : (
        <>
          <RowAction
            label="New file"
            onClick={() => {
              setAddingFolder(false);
              setAddingFileIn(null);
            }}
          >
            <FilePlus className="size-3" aria-hidden />
          </RowAction>
          <RowAction
            label="New folder"
            onClick={() => {
              setAddingFileIn(undefined);
              setAddingFolder(true);
            }}
          >
            <FolderPlus className="size-3" aria-hidden />
          </RowAction>
        </>
      ),
      insertRow: (folder, depth) => (
        <>
          {folder === null && addingFolder && (
            <NewNameRow
              kind="folder"
              depth={depth}
              onCommit={commitNewFolder}
              onCancel={() => setAddingFolder(false)}
            />
          )}
          {addingFileIn !== undefined && addingFileIn === folder && (
            <NewNameRow
              kind="file"
              depth={depth}
              onCommit={(name) => commitNewFile(folder, name)}
              onCancel={() => setAddingFileIn(undefined)}
            />
          )}
        </>
      ),
    },
    ...(!readOnly && trash.length > 0
      ? [
          {
            id: "trash",
            title: "Trash",
            count: trash.length,
            flat: true,
            files: trash.map(
              (entry): ExplorerItem => ({
                key: `trash:${entry.id}`,
                path: entry.file.path,
                name: entry.file.path,
                kind: "trash",
                trashId: entry.id,
                disabled: true,
              }),
            ),
          },
        ]
      : []),
  ];

  const explorer = (overlay: boolean) => (
    <FileExplorer
      label="Files"
      overlay={overlay}
      sections={sections}
      activeKey={openItem?.key ?? null}
      onOpen={(item) => setOpenKey(item.key)}
      fileIcon={(item) => <ContentFileIcon item={item} />}
      fileActions={
        readOnly
          ? undefined
          : (item) =>
              item.kind === "file" ? (
                <RowAction
                  label={`Move ${item.path} to trash`}
                  onClick={() => removeFiles(new Set([item.path]))}
                >
                  <Trash2 className="size-3" aria-hidden />
                </RowAction>
              ) : item.kind === "trash" ? (
                <>
                  <RowAction
                    label={`Restore ${item.path}`}
                    onClick={() => restore(item.trashId)}
                  >
                    <RotateCcw className="size-3" aria-hidden />
                  </RowAction>
                  <RowAction
                    label={`Delete ${item.path} permanently`}
                    onClick={() =>
                      setTrash((current) =>
                        current.filter((entry) => entry.id !== item.trashId),
                      )
                    }
                  >
                    <X className="size-3" aria-hidden />
                  </RowAction>
                </>
              ) : null
      }
      folderActions={
        readOnly
          ? undefined
          : (folder) => (
              <>
                <RowAction
                  label={`New file in ${folder}`}
                  onClick={() => {
                    setAddingFolder(false);
                    setAddingFileIn(folder);
                  }}
                >
                  <FilePlus className="size-3" aria-hidden />
                </RowAction>
                <RowAction
                  label={`Move ${folder} to trash`}
                  onClick={() => removeFolder(folder)}
                >
                  <Trash2 className="size-3" aria-hidden />
                </RowAction>
              </>
            )
      }
    />
  );

  const nameNotPublishable =
    manifestOpen &&
    parsed.name !== null &&
    !isSpecCompliantSkillName(parsed.name);

  // The trash is left out: only the files the skill or plugin holds now.
  const download: WorkspaceDownload | null =
    items.length > 0
      ? {
          name:
            downloadName ||
            parsed.name ||
            (manifest !== null ? "skill" : "plugin"),
          files: () => [
            ...(manifest !== null
              ? [{ path: MANIFEST_PATH, content: manifest }]
              : []),
            ...files.map((file) => ({
              path: file.path,
              content: file.content,
              encoding: file.encoding,
            })),
          ],
        }
      : null;

  return (
    <FileWorkspace
      className={cn("min-h-0 flex-1", className)}
      download={download}
      notice={
        nameNotPublishable && (
          <FileWorkspaceNotice title="Not publishable over MCP">
            Agent Skills names allow only lowercase letters, digits and single
            hyphens, up to 64 characters. The skill still works everywhere else.
          </FileWorkspaceNotice>
        )
      }
      explorer={explorer}
      explorerStorageKey="file-workspace-explorer-open"
      activeKey={openItem?.key ?? null}
      quickOpenLabel="Open a file"
      quickOpen={{
        title: "Open a file",
        description: "Search this skill's manifest and files.",
        groups: [
          {
            items: items.map((item) => ({
              key: item.key,
              search: item.path,
              icon: <ContentFileIcon item={item} />,
              label: item.name,
              detail: item.path.includes("/") ? item.path : undefined,
            })),
          },
        ],
        onSelect: setOpenKey,
      }}
      title={
        openItem ? (
          <>
            <ContentFileIcon item={openItem} />
            <FilePathLabel path={openItem.path} />
            {manifestOpen ? (
              <FileKindChip className="border-primary/30 bg-primary/10 text-primary">
                Manifest
              </FileKindChip>
            ) : openFile?.encoding === "base64" ? (
              <FileKindChip className="bg-muted text-muted-foreground">
                Binary
              </FileKindChip>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">No file open</span>
        )
      }
      actions={
        <>
          {manifestOpen && !readOnly && (
            <FrontmatterStatus
              hasName={parsed.hasName}
              hasDescription={parsed.hasDescription}
            />
          )}
          {readOnly && readOnlyMarker && (
            <IconBadge label="Read-only">
              <LockKeyhole className="size-3.5" aria-hidden />
            </IconBadge>
          )}
        </>
      }
    >
      {!openItem ? (
        <p className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {items.length === 0 ? "No files yet." : "Choose a file to read."}
        </p>
      ) : openFile?.encoding === "base64" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 bg-muted/30 text-center text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Binary asset</span>
          <span className="text-xs">
            {formatBytes(approxBase64Bytes(openFile.content))} · base64 encoded
          </span>
          <span className="max-w-xs text-xs">
            Stored verbatim for redistribution. Not editable here.
          </span>
        </div>
      ) : (
        <WorkspaceEditor
          className="min-h-0 flex-1"
          // Keyed by the open file, so Monaco swaps models instead of
          // carrying one file's undo stack and language into the next.
          key={openItem.key}
          language={editorLanguage(openItem.path)}
          value={openFile ? openFile.content : (manifest ?? "")}
          onChange={(value) => setEditorValue(value ?? "")}
          loading={
            <div className="flex h-full w-full items-center justify-center bg-muted/50">
              <p className="text-sm text-muted-foreground">Loading editor...</p>
            </div>
          }
          options={{
            ariaLabel: "File contents",
            placeholder: openFile ? "File contents..." : MANIFEST_PLACEHOLDER,
            readOnly,
            folding: true,
            tabSize: 2,
            renderLineHighlight: "line",
          }}
        />
      )}
      {manifestOpen && parsed.templated && <TemplatedManifestHint />}
    </FileWorkspace>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

interface TrashedFile {
  id: string;
  file: ResourceFile;
}

type ContentItem = WorkspaceFile &
  ({ kind: "manifest" } | { kind: "file"; file: ResourceFile });

type ExplorerItem =
  | ContentItem
  | (WorkspaceFile & { kind: "trash"; trashId: string });

let trashIdCounter = 0;
const nextTrashId = () => `trash-${++trashIdCounter}`;

const MANIFEST_KEY = "manifest";
const MANIFEST_PATH = "SKILL.md";

function fileKey(path: string): string {
  return `file:${path}`;
}

const MANIFEST_PLACEHOLDER = `---
name: my-skill
description: One line on when an agent should use this skill.
---

# My Skill

Step-by-step instructions for the agent...`;

function ContentFileIcon({ item }: { item: ExplorerItem }) {
  if (item.kind === "manifest")
    return <FileText className="size-3.5 shrink-0 text-primary" aria-hidden />;
  const Icon =
    item.kind === "file" && item.file.encoding === "base64"
      ? File
      : fileIconFor(item.path);
  return (
    <Icon
      className={cn(
        "size-3.5 shrink-0",
        item.kind === "trash"
          ? "text-muted-foreground/60"
          : "text-muted-foreground",
      )}
      aria-hidden
    />
  );
}

function fileIconFor(path: string) {
  const language = editorLanguage(path);
  if (language === "markdown" || language === "plaintext") return FileText;
  if (language === "shell" || language === "powershell") return FileTerminal;
  if (language === "json" || language === "yaml" || language === "ini")
    return FileBraces;
  return FileCode2;
}

/** A small icon button beside an explorer row or in a section header. */
function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          type="button"
          aria-label={label}
          onClick={onClick}
          className={FILE_ROW_ACTION_CLASS}
        >
          {children}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** A file or folder name being typed into the explorer. */
function NewNameRow({
  kind,
  depth,
  onCommit,
  onCancel,
}: {
  kind: "file" | "folder";
  depth: number;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const Icon = kind === "file" ? FileText : Folder;
  const commit = () => {
    const name = value.trim().replace(/\/+$/, "");
    if (name) onCommit(name);
  };
  return (
    <div
      className={cn(FILE_ROW_CLASS, "gap-1.5 hover:bg-transparent")}
      style={{ paddingLeft: fileRowIndent(depth) }}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <Input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!value.trim()) onCancel();
        }}
        placeholder={kind === "file" ? "filename.md" : "folder name"}
        aria-label={kind === "file" ? "File name" : "Folder name"}
        className="h-5 min-w-0 flex-1 rounded-sm px-1 font-mono text-[12px] md:text-[12px]"
      />
    </div>
  );
}

/** Whether SKILL.md's frontmatter names the skill and says what it does. */
function FrontmatterStatus({
  hasName,
  hasDescription,
}: {
  hasName: boolean;
  hasDescription: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="mr-1 hidden cursor-help items-center gap-1 text-[11px] text-muted-foreground sm:flex">
          <span>name</span>
          <Marker ok={hasName} />
          <span>· description</span>
          <Marker ok={hasDescription} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="max-w-xs">
        <code className="font-mono">name</code> and{" "}
        <code className="font-mono">description</code> must be set in the YAML
        frontmatter block (between the <code className="font-mono">---</code>{" "}
        fences) at the top of <code className="font-mono">SKILL.md</code>.
        Agents read these to decide when to use the skill.
      </TooltipContent>
    </Tooltip>
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

/** Shown when the manifest declares `templated: true`, mirroring the agent
 * system-prompt hint: the body is rendered with Handlebars at activation. */
function TemplatedManifestHint() {
  const docsUrl = getFrontendDocsUrl(
    DocsPage.PlatformAgents,
    "prompt-templates",
  );
  return (
    <p className="shrink-0 border-t px-3 py-1 text-[11px] text-muted-foreground">
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
  ps1: "powershell",
  toml: "ini",
  ini: "ini",
  html: "html",
  css: "css",
  sql: "sql",
  xml: "xml",
  txt: "plaintext",
};
