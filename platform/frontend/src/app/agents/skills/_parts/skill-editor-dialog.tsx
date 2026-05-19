"use client";

import { ChevronDown, ChevronRight, FileText, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateSkill,
  useSkill,
  useUpdateSkill,
} from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";

interface ResourceFile {
  path: string;
  content: string;
}

const MANIFEST_PLACEHOLDER = `---
name: my-skill
description: One line on when an agent should use this skill.
---

# My Skill

Step-by-step instructions for the agent...`;

export function SkillEditorDialog({
  skillId,
  open,
  onOpenChange,
}: {
  skillId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isEdit = skillId !== null;
  const { data: skill, isPending: isLoading } = useSkill(open ? skillId : null);
  const createSkill = useCreateSkill();
  const updateSkill = useUpdateSkill();

  const [manifest, setManifest] = useState("");
  const [files, setFiles] = useState<ResourceFile[]>([]);
  // null = the SKILL.md manifest is open; otherwise an index into `files`.
  const [openFileIndex, setOpenFileIndex] = useState<number | null>(null);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");

  // Hydrate the editor whenever the dialog opens (or the loaded skill changes).
  useEffect(() => {
    if (!open) return;
    if (isEdit && skill) {
      setManifest(composeManifest(skill));
      setFiles(skill.files.map(({ path, content }) => ({ path, content })));
    } else if (!isEdit) {
      setManifest("");
      setFiles([]);
    }
    setOpenFileIndex(null);
    setNewFilePath("");
  }, [open, isEdit, skill]);

  const parsed = useMemo(() => parseManifestFields(manifest), [manifest]);
  const isSaving = createSkill.isPending || updateSkill.isPending;
  const canSave = parsed.hasName && parsed.hasDescription && !isSaving;

  const handleSave = async () => {
    const body = { content: manifest, files };
    const result = isEdit
      ? await updateSkill.mutateAsync({ id: skillId, body })
      : await createSkill.mutateAsync(body);
    if (result) {
      onOpenChange(false);
    }
  };

  const addFile = () => {
    const path = newFilePath.trim();
    if (!path || files.some((file) => file.path === path)) return;
    setFiles((prev) => [...prev, { path, content: "" }]);
    setNewFilePath("");
    setOpenFileIndex(files.length);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setOpenFileIndex((current) => {
      if (current === index) return null;
      if (current !== null && current > index) return current - 1;
      return current;
    });
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
      title={isEdit ? "Edit skill" : "New skill"}
      description="A skill is a SKILL.md instruction set plus optional resource files."
      size="large"
      footer={
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
      }
    >
      {isEdit && isLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          Loading skill...
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>
                {openFile ? (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setOpenFileIndex(null)}
                  >
                    SKILL.md
                  </button>
                ) : (
                  "SKILL.md"
                )}
                {openFile && (
                  <span className="text-muted-foreground">
                    {" / "}
                    <span className="text-foreground">{openFile.path}</span>
                  </span>
                )}
              </Label>
              {!openFile && (
                <span className="text-xs text-muted-foreground">
                  parsed: name <Marker ok={parsed.hasName} /> · description{" "}
                  <Marker ok={parsed.hasDescription} />
                </span>
              )}
            </div>
            <Textarea
              value={editorValue}
              onChange={(e) => setEditorValue(e.target.value)}
              placeholder={openFile ? "File contents..." : MANIFEST_PLACEHOLDER}
              className="min-h-[320px] font-mono text-xs"
              spellCheck={false}
            />
          </div>

          <div className="rounded-md border">
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-sm"
              onClick={() => setFilesExpanded((v) => !v)}
            >
              <span className="flex items-center gap-1.5 font-medium">
                {filesExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
                Resource files ({files.length})
              </span>
              <span className="text-xs text-muted-foreground">
                references/ · scripts/ · assets/
              </span>
            </button>

            {filesExpanded && (
              <div className="border-t p-2">
                {files.length === 0 && (
                  <p className="px-1 py-1.5 text-xs text-muted-foreground">
                    No resource files. Most skills are just a SKILL.md.
                  </p>
                )}
                <ul className="space-y-1">
                  {files.map((file, index) => (
                    <li
                      key={file.path}
                      className={cn(
                        "flex items-center gap-2 rounded px-2 py-1.5 text-sm",
                        openFileIndex === index && "bg-muted",
                      )}
                    >
                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate font-mono text-xs">
                        {file.path}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {deriveKind(file.path)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => setOpenFileIndex(index)}
                      >
                        open
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => removeFile(index)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    value={newFilePath}
                    onChange={(e) => setNewFilePath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addFile();
                      }
                    }}
                    placeholder="references/new-file.md"
                    className="h-8 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addFile}
                    disabled={!newFilePath.trim()}
                  >
                    Add
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </StandardDialog>
  );
}

function Marker({ ok }: { ok: boolean }) {
  return (
    <span className={ok ? "text-emerald-600" : "text-muted-foreground"}>
      {ok ? "✓" : "—"}
    </span>
  );
}

// ===== Manifest helpers =====

/** Lightweight client-side check that frontmatter has the required fields. */
function parseManifestFields(raw: string): {
  hasName: boolean;
  hasDescription: boolean;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = match?.[1] ?? "";
  return {
    hasName: /^name:\s*\S/m.test(frontmatter),
    hasDescription: /^description:\s*\S/m.test(frontmatter),
  };
}

/** Rebuild a raw SKILL.md from a stored skill (frontmatter + body). */
function composeManifest(skill: {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  content: string;
}): string {
  const lines = [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
  ];
  if (skill.license) lines.push(`license: ${skill.license}`);
  if (skill.compatibility) lines.push(`compatibility: ${skill.compatibility}`);
  const metadataEntries = Object.entries(skill.metadata ?? {});
  if (metadataEntries.length > 0) {
    lines.push("metadata:");
    for (const [key, value] of metadataEntries) {
      lines.push(`  ${key}: ${value}`);
    }
  }
  lines.push("---", "", skill.content);
  return lines.join("\n");
}

function deriveKind(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("assets/")) return "asset";
  return "reference";
}
