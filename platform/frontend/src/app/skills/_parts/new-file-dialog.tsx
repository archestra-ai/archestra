"use client";

import { ChevronRight, Folder, FolderOpen, FolderPlus, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
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
      ? itemKind === "file"
        ? "Enter a name only, without / or \\. Pick the folder above."
        : "Enter one folder name, without / or \\."
      : leaf === "." || leaf === ".."
        ? "A name cannot be . or .."
        : problem(itemKind, pathOf(leaf));

  // The row that adds a folder sits in the tree, inside the picked folder:
  // where the new folder will appear.
  const addFolder = (depth: number) => (
    <AddFolderRow
      key={`add:${location ?? ""}`}
      depth={depth}
      location={location}
      problem={(leaf) => nameProblem("folder", leaf)}
      onAdd={(leaf) => {
        const path = pathOf(leaf);
        setAdded((current) => [...current, path]);
        setLocation(path);
      }}
    />
  );
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
        <DialogBody className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label id={`${nameId}-location`}>Folder</Label>
            {/* No box around the tree: the dialog is the only surface. The
                rows hang out by their padding, so their text lines up with
                the labels and the selection reads as one soft bar. */}
            <div
              role="radiogroup"
              aria-labelledby={`${nameId}-location`}
              className="-mx-2 flex max-h-56 flex-col overflow-y-auto"
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
                onSelect={(path) => {
                  setLocation(path);
                  // The picked folder opens, to show what a new one joins.
                  setCollapsed((current) => {
                    if (!current.has(path)) return current;
                    const next = new Set(current);
                    next.delete(path);
                    return next;
                  });
                }}
                onToggle={(path) =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
                addFolder={addFolder}
              />
              {location === null && addFolder(1)}
            </div>
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
              <InlineNotice id={refusalId} variant="error" size="xs" plain>
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
  addFolder,
}: {
  nodes: FolderNode[];
  depth: number;
  location: string | null;
  collapsed: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  /** The add-a-folder row, drawn inside the picked folder at that depth. */
  addFolder: (depth: number) => ReactNode;
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
            addFolder={addFolder}
          />
        )}
        {location === node.path && addFolder(depth + 1)}
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
        "flex h-8 shrink-0 items-center gap-1 rounded-md pr-2 text-sm",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
      style={{ paddingLeft: rowIndent(depth) }}
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

/** Left padding of a tree row at a depth. */
function rowIndent(depth: number): number {
  return 4 + depth * 16;
}

/**
 * Adds a folder inside the picked one, for a file whose folder does not exist
 * yet. It is a row of the tree, in the place the folder will take. Closed, a
 * quiet "New folder"; open, the name, where Enter adds the folder and does not
 * create the file.
 */
function AddFolderRow({
  depth,
  location,
  problem,
  onAdd,
}: {
  depth: number;
  location: string | null;
  problem: (name: string) => string | null;
  onAdd: (name: string) => void;
}) {
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
  // The chevron's width and the row's gap, so the icon lines up with the
  // folder icons above.
  const indent = rowIndent(depth) + 24;

  if (!open) {
    return (
      <UnstyledButton
        type="button"
        aria-label={
          location ? `New folder in ${location}` : "New folder at top level"
        }
        onClick={() => setOpen(true)}
        className="flex h-8 shrink-0 items-center gap-2 rounded-md pr-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ paddingLeft: indent }}
      >
        <FolderPlus className="size-4 shrink-0" aria-hidden />
        <span>New folder</span>
      </UnstyledButton>
    );
  }
  return (
    <div className="flex shrink-0 flex-col gap-1 py-0.5 pr-1">
      <div className="flex items-center gap-2" style={{ paddingLeft: indent }}>
        <FolderPlus
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <Input
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
              // Only this row closes, not the dialog around it.
              event.stopPropagation();
              close();
            }
          }}
          placeholder="folder-name"
          aria-label="New folder name"
          className="h-8 min-w-0 flex-1 font-mono"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={refusal ? true : undefined}
        />
        <Button type="button" variant="ghost" size="sm" onClick={add}>
          Add
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Cancel the new folder"
          onClick={close}
        >
          <X aria-hidden />
        </Button>
      </div>
      {refusal && (
        <div style={{ paddingLeft: indent + 24 }}>
          <InlineNotice variant="error" size="xs" plain>
            <InlineNoticeText>{refusal}</InlineNoticeText>
          </InlineNotice>
        </div>
      )}
    </div>
  );
}
