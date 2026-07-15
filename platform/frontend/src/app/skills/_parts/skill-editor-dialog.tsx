"use client";

import { DocsPage, type ResourceVisibilityScope } from "@archestra/shared";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Github,
  MessageSquare,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useCreateSkill,
  useSkill,
  useUpdateSkill,
} from "@/lib/skills/skill.query";
import { formatBytes } from "@/lib/skills-sandbox/sandbox-file-preview";
import { cn } from "@/lib/utils";
import { composeManifest, parseManifestFields } from "./manifest-compose";
import { SkillScopeSelector } from "./skill-scope-selector";

interface ResourceFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
}

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

const BLANK_TEMPLATE = `---
name: template-skill
description: Replace with description of the skill and when Agents should use it.
---

# Insert instructions below
`;

const ROOT_ADD_KEY = "";

export interface SkillPreview {
  name: string;
  description: string;
  content: string;
  license: string | null;
  compatibility: string | null;
  allowedTools: string | null;
  templated: boolean;
  metadata: Record<string, string>;
  files: (ResourceFile & { kind?: "reference" | "script" | "asset" })[];
}

export function SkillEditorDialog({
  skillId,
  open,
  onOpenChange,
  onSaved,
  preview,
  isPreviewLoading,
}: {
  skillId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
  preview?: SkillPreview | null;
  isPreviewLoading?: boolean;
}) {
  const isPreview = preview !== undefined;
  const isEdit = !isPreview && skillId !== null;
  const { data: skill, isPending: isLoading } = useSkill(
    open && !isPreview ? skillId : null,
  );
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();
  const appName = useAppName();

  // GitHub-imported skills are a one-time snapshot, not a live link: editing
  // here never touches the repo, and the repo is never re-pulled. Surface that
  // in edit mode so the disconnect isn't a surprise.
  const isGithubSkill = isEdit && skill?.sourceType === "github";
  const githubSourceRepo = isGithubSkill
    ? (skill?.sourceRef?.split("@")[0] ?? null)
    : null;

  const [manifest, setManifest] = useState("");
  const [files, setFiles] = useState<ResourceFile[]>([]);
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  // null = the SKILL.md manifest is open; otherwise an index into `files`.
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
  // soft-deleted files held in a trash bin until the dialog is closed; restorable until then.
  const [trash, setTrash] = useState<TrashedFile[]>([]);
  const [trashExpanded, setTrashExpanded] = useState(true);

  // A dead deep link (`/skills?edit=<id>` for a deleted or inaccessible
  // skill) resolves to null; close instead of showing a blank editor.
  useEffect(() => {
    if (open && isEdit && !isLoading && !skill) {
      toast.error("Skill not found");
      onOpenChange(false);
    }
  }, [open, isEdit, isLoading, skill, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    if (isPreview) {
      if (preview) {
        setManifest(composeManifest(preview));
        setFiles(
          preview.files.map(({ path, content, encoding }) => ({
            path,
            content,
            encoding,
          })),
        );
      } else {
        setManifest("");
        setFiles([]);
      }
    } else if (isEdit && skill) {
      setManifest(composeManifest(skill));
      setFiles(
        skill.files.map(({ path, content, encoding }) => ({
          path,
          content,
          encoding,
        })),
      );
      setScope(skill.scope);
      setTeamIds(skill.teams.map((team) => team.id));
    } else if (!isEdit) {
      setManifest(BLANK_TEMPLATE);
      setFiles([]);
      setScope("personal");
      setTeamIds([]);
    }
    setOpenFileIndex(null);
    setAddingIn(null);
    setNewFileName("");
    setCollapsedFolders(new Set());
    setPendingFolders([]);
    setAddingNewFolder(false);
    setNewFolderName("");
    setTrash([]);
    setTrashExpanded(true);
  }, [open, isPreview, preview, isEdit, skill]);

  const parsed = useMemo(() => parseManifestFields(manifest), [manifest]);
  const isSaving = createSkill.isPending || updateSkill.isPending;
  const canSave = parsed.hasName && parsed.hasDescription && !isSaving;

  const tree = useMemo(
    () => buildTree(files, pendingFolders),
    [files, pendingFolders],
  );

  const handleSave = async () => {
    const body = {
      content: manifest,
      files,
      scope,
      teamIds: scope === "team" ? teamIds : [],
    };
    const result = isEdit
      ? await updateSkill.mutateAsync({ id: skillId, body })
      : await createSkill.mutateAsync(body);
    if (result) {
      onOpenChange(false);
      onSaved?.();
    }
  };

  const commitNewFile = (folder: string | null) => {
    const name = newFileName.trim();
    if (!name) return;
    const path = folder ? `${folder}/${name}` : name;
    if (files.some((f) => f.path === path)) return;
    setFiles((prev) => [...prev, { path, content: "", encoding: "utf8" }]);
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
    setFiles((prev) => prev.filter((_, i) => i !== index));
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
    setFiles((prev) => prev.filter((f) => !f.path.startsWith(prefix)));
    setPendingFolders((prev) => prev.filter((f) => f !== folder));
    if (openWasInFolder) setOpenFileIndex(null);
  };

  const restoreFile = (id: string) => {
    const item = trash.find((t) => t.id === id);
    if (!item) return;
    setTrash((prev) => prev.filter((t) => t.id !== id));
    if (files.some((f) => f.path === item.file.path)) return;
    setFiles((prev) => [...prev, item.file]);
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
      setManifest(value);
    } else {
      setFiles((prev) =>
        prev.map((file, i) =>
          i === openFileIndex ? { ...file, content: value } : file,
        ),
      );
    }
  };

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        isPreview
          ? (preview?.name ?? "Preview skill")
          : isEdit
            ? "Edit skill"
            : "New skill"
      }
      description={
        isPreview
          ? "Preview of a skill that has not been imported yet."
          : "A skill is a SKILL.md instruction set plus optional resource files."
      }
      size="large"
      bodyClassName="flex flex-col overflow-hidden"
      footer={
        <>
          {/* Existing skills only (edit/preview with an id) — a skill being
              created has no id to start a chat with yet. */}
          {skillId !== null && (
            <PermissionButton
              permissions={{ chat: ["read", "create"] }}
              variant="outline"
              asChild
            >
              <Link href={`/chat/new?skill_id=${skillId}`}>
                <MessageSquare className="h-4 w-4" />
                Chat
              </Link>
            </PermissionButton>
          )}
          {isPreview ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="button" disabled={!canSave} onClick={handleSave}>
                {isSaving ? "Saving..." : "Save skill"}
              </Button>
            </>
          )}
        </>
      }
    >
      {(isPreview && isPreviewLoading) || (isEdit && isLoading) ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          Loading skill...
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col gap-4">
          {isGithubSkill && (
            <div className="flex gap-2.5 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
              <Github className="mt-0.5 size-4 shrink-0" />
              <p>
                Imported from{" "}
                {githubSourceRepo ? (
                  <code className="font-mono text-foreground">
                    {githubSourceRepo}
                  </code>
                ) : (
                  "GitHub"
                )}{" "}
                as a one-time copy. Saving changes here won’t update the repo,
                and {appName} won’t pull later changes from it.
              </p>
            </div>
          )}
          <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] gap-3">
            <div className="flex min-h-0 flex-col rounded-md border">
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
                          readOnly={isPreview}
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
                                readOnly={isPreview}
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
                      readOnly={isPreview}
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

              {!isPreview && trash.length > 0 && (
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

              {!isPreview && addingNewFolder && (
                <div className="border-t p-2">
                  <NewFolderRow
                    value={newFolderName}
                    onChange={setNewFolderName}
                    onCommit={commitNewFolder}
                    onCancel={cancelAddingFolder}
                  />
                </div>
              )}

              {!isPreview && addingIn === null && !addingNewFolder && (
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
                <Label className="font-mono text-xs">
                  {openFile ? openFile.path : "SKILL.md"}
                </Label>
                {!openFile && !isPreview && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help text-xs text-muted-foreground">
                        frontmatter: name <Marker ok={parsed.hasName} /> ·
                        description <Marker ok={parsed.hasDescription} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <code className="font-mono">name</code> and{" "}
                      <code className="font-mono">description</code> must be set
                      in the YAML frontmatter block (between the{" "}
                      <code className="font-mono">---</code> fences) at the top
                      of <code className="font-mono">SKILL.md</code>. Agents
                      read these to decide when to use the skill.
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              {openFile && openFile.encoding === "base64" ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 rounded-md border bg-muted/30 text-center text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">
                    Binary asset
                  </span>
                  <span className="text-xs">
                    {formatBytes(approxBase64Bytes(openFile.content))} · base64
                    encoded
                  </span>
                  <span className="max-w-xs text-xs">
                    Stored verbatim for redistribution. Not editable here.
                  </span>
                </div>
              ) : (
                <Textarea
                  value={editorValue}
                  onChange={(e) => setEditorValue(e.target.value)}
                  aria-label="File contents"
                  placeholder={
                    openFile ? "File contents..." : MANIFEST_PLACEHOLDER
                  }
                  className="min-h-0 flex-1 resize-none font-mono text-xs"
                  spellCheck={false}
                  readOnly={isPreview}
                />
              )}
              {!openFile && parsed.templated && <TemplatedManifestHint />}
            </div>
          </div>

          {!isPreview && (
            <SkillScopeSelector
              scope={scope}
              onScopeChange={setScope}
              teamIds={teamIds}
              onTeamIdsChange={setTeamIds}
            />
          )}
        </div>
      )}
    </StandardDialog>
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
        "."
      )}
    </p>
  );
}
