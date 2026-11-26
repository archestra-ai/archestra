"use client";

import { DocsPage, isSpecCompliantSkillName } from "@archestra/shared";
import {
  File,
  FileBraces,
  FileCode2,
  FilePlus,
  FileTerminal,
  FileText,
  LockKeyhole,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import type { WorkspaceDownload } from "@/components/file-workspace/download-zip";
import {
  FileExplorer,
  type FileExplorerSection,
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
import { Button } from "@/components/ui/button";
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
import { contentFilePathProblem } from "./content-file-path";
import { NewFileDialog } from "./new-file-dialog";
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
 * file, the session trash bin) is kept here.
 */
export function SkillContentEditor({
  manifest,
  files,
  onManifestChange,
  onFilesChange,
  readOnly = false,
  readOnlyMarker = true,
  downloadName,
  showDownload = true,
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
  /**
   * Whether the bar offers the files as a .zip. Off where the host's own
   * header does, so the button is not read as "download the open file".
   */
  showDownload?: boolean;
  className?: string;
}) {
  const [openKey, setOpenKey] = useState<string | null>(() =>
    manifest !== null ? MANIFEST_KEY : files[0] ? fileKey(files[0].path) : null,
  );
  // Whether the New file dialog is open.
  const [creating, setCreating] = useState(false);
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
  // Falls back to the first file when the open one is gone (moved to the
  // trash), so the pane shows a file for as long as there is one.
  const openItem = items.find((item) => item.key === openKey) ?? items[0];
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
  };
  const restore = (id: string) => {
    const item = trash.find((entry) => entry.id === id);
    if (!item) return;
    setTrash((current) => current.filter((entry) => entry.id !== id));
    if (files.some((file) => file.path === item.file.path)) return;
    onFilesChange((current) => [...current, item.file]);
  };
  // Every folder the files are in: what the dialog offers as the place for
  // a new file.
  const folderPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const file of files) {
      const parts = file.path.split("/").slice(0, -1);
      parts.forEach((_, index) => {
        paths.add(parts.slice(0, index + 1).join("/"));
      });
    }
    return [...paths];
  }, [files]);
  const newPathProblem = (kind: "file" | "folder", path: string) =>
    contentFilePathProblem({
      // A folder is its first file's parent, so it answers to the same rules.
      path: kind === "file" ? path : `${path}/file`,
      existingPaths: files.map((file) => file.path),
      manifestPath:
        kind === "file" && manifest !== null ? MANIFEST_PATH : undefined,
    });
  const createFile = (path: string) => {
    onFilesChange((current) => [
      ...current,
      { path, content: "", encoding: "utf8" },
    ]);
    setOpenKey(fileKey(path));
    setCreating(false);
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
      empty: <p>No files yet.</p>,
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
      // Shown on every row, not only under the pointer: the delete button
      // was hard to find.
      actionsAlwaysShown
      fileActions={
        readOnly
          ? undefined
          : (item) =>
              item.kind === "file" ? (
                <RowAction
                  label="Delete"
                  name={`Delete ${item.path}`}
                  destructive
                  onClick={() => removeFiles(new Set([item.path]))}
                >
                  <Trash2 aria-hidden />
                </RowAction>
              ) : item.kind === "trash" ? (
                <>
                  <RowAction
                    label="Restore"
                    name={`Restore ${item.path}`}
                    onClick={() => restore(item.trashId)}
                  >
                    <RotateCcw aria-hidden />
                  </RowAction>
                  <RowAction
                    label="Delete permanently"
                    name={`Delete ${item.path} permanently`}
                    destructive
                    onClick={() =>
                      setTrash((current) =>
                        current.filter((entry) => entry.id !== item.trashId),
                      )
                    }
                  >
                    <X aria-hidden />
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
                  label="Delete"
                  name={`Delete folder ${folder}`}
                  destructive
                  onClick={() => removeFolder(folder)}
                >
                  <Trash2 aria-hidden />
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
    <>
      <NewFileDialog
        open={creating}
        folders={folderPaths}
        problem={newPathProblem}
        onCreate={createFile}
        onClose={() => setCreating(false)}
      />
      <FileWorkspace
        className={cn("min-h-0 flex-1", className)}
        download={showDownload ? download : null}
        notice={
          nameNotPublishable && (
            <FileWorkspaceNotice title="Not publishable over MCP">
              Agent Skills names allow only lowercase letters, digits and single
              hyphens, up to 64 characters. The skill still works everywhere
              else.
            </FileWorkspaceNotice>
          )
        }
        explorer={explorer}
        // A handful of files: the list is always shown, with no toggle.
        explorerToggle={false}
        // A labelled button on the editor's own bar. As a 12px icon in the
        // file list's header it was hard to find.
        leading={
          readOnly ? undefined : (
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-6"
              onClick={() => setCreating(true)}
            >
              <FilePlus aria-hidden />
              <span>New file or folder</span>
            </Button>
          )
        }
        activeKey={openItem?.key ?? null}
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
            {items.length === 0 ? "No files yet." : "Choose a file to open."}
          </p>
        ) : openFile?.encoding === "base64" ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 bg-muted/30 text-center text-sm text-muted-foreground">
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
                <p className="text-sm text-muted-foreground">
                  Loading editor...
                </p>
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
    </>
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

/**
 * An icon button beside an explorer row. Always on the row, at a size and
 * contrast that can be found without hovering for it. `label` is the short
 * word shown on hover; `name` adds which row it acts on for a screen reader.
 */
function RowAction({
  label,
  name,
  destructive = false,
  onClick,
  children,
}: {
  label: string;
  name: string;
  destructive?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          type="button"
          aria-label={name}
          onClick={onClick}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-sm text-foreground/70 outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground [&>svg]:size-3.5",
            destructive &&
              "hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive",
          )}
        >
          {children}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
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
