"use client";

import { ChevronRight, Folder, FolderOpen, FolderPlus } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";

/**
 * Names a new file for the plugin and skill file editor.
 *
 * The place comes first and is picked, not typed: the folders are a tree to
 * click through, and a folder that is missing is added there, on the way to
 * the file that needs it; there is no other way to make a folder, since one
 * exists only through the files in it. Only the name is typed. It is checked
 * when it is submitted; a refused name stays in the field with the reason, to
 * correct.
 */
export function NewFileDialog({
  open,
  folders,
  problem,
  onCreate,
  onClose,
}: {
  open: boolean;
  /** Every folder the files are in, as paths. */
  folders: readonly string[];
  /** Why a file or a folder cannot have this full path; null when it can. */
  problem: (kind: "file" | "folder", path: string) => string | null;
  /** Creates the file at this full path. */
  onCreate: (path: string) => void;
  onClose: () => void;
}) {
  const nameId = useId();
  const refusalId = useId();
  const [location, setLocation] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  // Folders added in this dialog, on the way to a file. They exist once the
  // file is created inside them, and are forgotten if the dialog is closed.
  const [added, setAdded] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // A fresh dialog each time it opens.
  useEffect(() => {
    if (!open) return;
    setLocation(null);
    setName("");
    setRefusal(null);
    setAdded([]);
    setCollapsed(new Set());
  }, [open]);

  const tree = useMemo(
    () => folderTree([...folders, ...added]),
    [folders, added],
  );
  const pathOf = (leaf: string) => (location ? `${location}/${leaf}` : leaf);
  // Both fields take one name, never a path: the tree is where the place is
  // chosen, so a separator or a "go up" segment has no meaning in them.
  const nameProblem = (itemKind: "file" | "folder", leaf: string) =>
    /[/\\]/.test(leaf)
      ? "Enter a name only, without / or \\. Pick the folder above."
      : leaf === "." || leaf === ".."
        ? "A name cannot be . or .."
        : problem(itemKind, pathOf(leaf));

  const submit = () => {
    const leaf = name.trim();
    if (!leaf) return;
    const reason = nameProblem("file", leaf);
    if (reason) setRefusal(reason);
    else onCreate(pathOf(leaf));
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="New file or folder"
      size="small"
    >
      <DialogForm
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          // The editor's page has a form of its own around it.
          event.stopPropagation();
          submit();
        }}
      >
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label id={`${nameId}-location`}>Folder</Label>
            <div
              role="radiogroup"
              aria-labelledby={`${nameId}-location`}
              className="max-h-48 overflow-y-auto rounded-md border py-1"
            >
              <FolderRow
                label="Top level"
                depth={0}
                selected={location === null}
                onSelect={() => setLocation(null)}
              />
              <FolderRows
                nodes={tree}
                depth={1}
                location={location}
                collapsed={collapsed}
                onSelect={setLocation}
                onToggle={(path) =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
              />
            </div>
            <AddFolderHere
              location={location}
              problem={(leaf) => nameProblem("folder", leaf)}
              onAdd={(leaf) => {
                const path = pathOf(leaf);
                setAdded((current) => [...current, path]);
                setLocation(path);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>File name</Label>
            <Input
              id={nameId}
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setRefusal(null);
              }}
              placeholder="filename.md"
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={refusal ? true : undefined}
              aria-describedby={refusal ? refusalId : undefined}
            />
            {refusal && (
              <InlineNotice id={refusalId} variant="error" size="xs">
                <InlineNoticeText>{refusal}</InlineNoticeText>
              </InlineNotice>
            )}
          </div>
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={name.trim() === ""}>
            Create file
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
}

/** The folders as a tree, each level sorted by name. */
function folderTree(paths: readonly string[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();
  for (const path of [...new Set(paths)].sort((a, b) => a.localeCompare(b))) {
    let parent: FolderNode[] = roots;
    let prefix = "";
    for (const name of path.split("/")) {
      prefix = prefix ? `${prefix}/${name}` : name;
      let node = byPath.get(prefix);
      if (!node) {
        node = { name, path: prefix, children: [] };
        byPath.set(prefix, node);
        parent.push(node);
      }
      parent = node.children;
    }
  }
  return roots;
}

function FolderRows({
  nodes,
  depth,
  location,
  collapsed,
  onSelect,
  onToggle,
}: {
  nodes: FolderNode[];
  depth: number;
  location: string | null;
  collapsed: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  return nodes.map((node) => {
    const open = !collapsed.has(node.path);
    return (
      <div key={node.path}>
        <FolderRow
          label={node.name}
          depth={depth}
          selected={location === node.path}
          onSelect={() => onSelect(node.path)}
          expanded={node.children.length > 0 ? open : undefined}
          onToggle={() => onToggle(node.path)}
        />
        {open && node.children.length > 0 && (
          <FolderRows
            nodes={node.children}
            depth={depth + 1}
            location={location}
            collapsed={collapsed}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        )}
      </div>
    );
  });
}

/** One folder to pick: the row selects it, the chevron opens and closes it. */
function FolderRow({
  label,
  depth,
  selected,
  onSelect,
  expanded,
  onToggle,
}: {
  label: string;
  depth: number;
  selected: boolean;
  onSelect: () => void;
  /** Undefined for a folder with no folders inside. */
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const Icon = selected ? FolderOpen : Folder;
  return (
    <div
      className={cn(
        "flex h-8 items-center gap-1 pr-2 text-sm",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      style={{ paddingLeft: 8 + depth * 16 }}
    >
      {expanded === undefined ? (
        <span className="size-5 shrink-0" aria-hidden />
      ) : (
        <UnstyledButton
          type="button"
          aria-label={expanded ? `Close ${label}` : `Open ${label}`}
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              "size-3.5 transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
        </UnstyledButton>
      )}
      <UnstyledButton
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className={cn("truncate", selected && "font-medium")}>
          {label}
        </span>
      </UnstyledButton>
    </div>
  );
}

/**
 * Adds a folder inside the picked one, for a file whose folder does not exist
 * yet. Closed, it is one button; open, a name and its own confirm, so Enter in
 * it adds the folder and does not create the file.
 */
function AddFolderHere({
  location,
  problem,
  onAdd,
}: {
  location: string | null;
  problem: (name: string) => string | null;
  onAdd: (name: string) => void;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setName("");
    setRefusal(null);
  };
  const add = () => {
    const leaf = name.trim();
    if (!leaf) return;
    const reason = problem(leaf);
    if (reason) {
      setRefusal(reason);
      return;
    }
    onAdd(leaf);
    close();
  };

  if (!open) {
    return (
      <div>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => setOpen(true)}
        >
          <FolderPlus aria-hidden />
          <span>
            {location ? `New folder in ${location}` : "New folder at top level"}
          </span>
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setRefusal(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            } else if (event.key === "Escape") {
              // Only this field closes, not the dialog around it.
              event.stopPropagation();
              close();
            }
          }}
          placeholder="folder-name"
          aria-label="New folder name"
          className="font-mono"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={refusal ? true : undefined}
        />
        <Button type="button" variant="outline" onClick={add}>
          Add
        </Button>
        <Button type="button" variant="ghost" onClick={close}>
          Cancel
        </Button>
      </div>
      {refusal && (
        <InlineNotice variant="error" size="xs">
          <InlineNoticeText>{refusal}</InlineNoticeText>
        </InlineNotice>
      )}
    </div>
  );
}
