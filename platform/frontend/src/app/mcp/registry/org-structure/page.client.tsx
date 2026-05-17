"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import pluralize from "pluralize";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type McpPresetEntryWithAssignedCount,
  useCreateMcpPresetEntry,
  useDeleteMcpPresetEntry,
  useMcpPresetEntries,
} from "@/lib/mcp/mcp-preset-entry.query";
import {
  useOrganization,
  usePresetEntityName,
  useUpdatePresetEntityName,
} from "@/lib/organization.query";

export default function OrgStructurePageClient() {
  const { data: organization } = useOrganization();
  const { configured, singular, plural } = usePresetEntityName();
  const { data: canEdit } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });

  if (!organization) return null;

  return (
    <div className="space-y-4">
      {!configured && (
        <>
          <div className="space-y-2 text-sm">
            <p>
              Use this feature if your organization has multiple business units
              or environments, and you want each to have its own MCP server
              configuration. The chosen category will be visible in the settings
              of each MCP server.
            </p>

            <p>For example:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                MCP servers across different{" "}
                <span className="font-semibold">
                  &ldquo;Environments&rdquo;
                </span>{" "}
                may connect to different 3rd-party system URLs. Production to{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  prod.acme.com/api
                </code>{" "}
                and staging to{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  staging.acme.com/api
                </code>
                .
              </li>
              <li>
                MCP servers of different{" "}
                <span className="font-semibold">
                  &ldquo;Business Units&rdquo;
                </span>{" "}
                may have different OAuth scopes. Sales:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  history:read
                </code>
                , and engineering:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  history:read, history:write
                </code>
                .
              </li>
            </ul>
          </div>

          <NameSection canEdit={canEdit ?? false} />
        </>
      )}

      {configured && (
        <EntriesSection
          canEdit={canEdit ?? false}
          singular={singular}
          plural={plural}
        />
      )}
    </div>
  );
}

const TERM_SUGGESTIONS = [
  "Environment",
  "Business Unit",
  "Studio",
  "Client",
  "Project",
];

function NameSection({ canEdit }: { canEdit: boolean }) {
  const updateMutation = useUpdatePresetEntityName(
    "Org structure name saved",
    "Failed to save name",
  );

  const [singularDraft, setSingularDraft] = useState("");

  const trimmedSingular = singularDraft.trim();
  const canSave = trimmedSingular.length > 0;

  const handleSave = () => {
    updateMutation.mutate({
      presetEntityName: trimmedSingular,
      presetEntityNamePlural: pluralize(trimmedSingular),
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-sm">
        Which term best fits how you want to categorize these configurations?
      </p>

      <div className="space-y-1.5">
        <p className="text-sm">Pick one:</p>
        <div className="flex flex-wrap gap-2">
          {TERM_SUGGESTIONS.map((term) => (
            <Button
              key={term}
              type="button"
              variant="outline"
              size="sm"
              className="rounded-full"
              disabled={!canEdit}
              onClick={() => setSingularDraft(term)}
            >
              {term}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm">Or type your own:</p>
        <Input
          id="preset-entity-singular"
          value={singularDraft}
          onChange={(e) => setSingularDraft(e.target.value)}
          placeholder="e.g. Environment"
          maxLength={50}
          disabled={!canEdit}
        />
      </div>

      <div className="flex justify-end pt-1">
        <Button
          onClick={handleSave}
          disabled={!canEdit || !canSave || updateMutation.isPending}
        >
          {updateMutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

function NameEditorDialog({
  open,
  onOpenChange,
  initialSingular,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSingular: string;
}) {
  const updateMutation = useUpdatePresetEntityName(
    "Org structure name saved",
    "Failed to save name",
  );

  const [singularDraft, setSingularDraft] = useState(initialSingular);

  const trimmedSingular = singularDraft.trim();
  const canSave =
    trimmedSingular.length > 0 && trimmedSingular !== initialSingular;

  const handleSave = () => {
    updateMutation.mutate(
      {
        presetEntityName: trimmedSingular,
        presetEntityNamePlural: pluralize(trimmedSingular),
      },
      {
        onSuccess: () => onOpenChange(false),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setSingularDraft(initialSingular);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename org structure</DialogTitle>
          <DialogDescription>
            Update the name used throughout the catalog.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="preset-entity-singular-dialog">
            Name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="preset-entity-singular-dialog"
            value={singularDraft}
            onChange={(e) => setSingularDraft(e.target.value)}
            placeholder="e.g. Environment"
            maxLength={50}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSave || updateMutation.isPending}
          >
            {updateMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EntriesSection({
  canEdit,
  singular,
  plural,
}: {
  canEdit: boolean;
  singular: string;
  plural: string;
}) {
  const { data: entries = [], isLoading } = useMcpPresetEntries();
  const createMutation = useCreateMcpPresetEntry();
  const [addingName, setAddingName] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<McpPresetEntryWithAssignedCount | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  const handleAdd = (name: string) => {
    if (!name.trim()) {
      setAddingName(null);
      return;
    }
    createMutation.mutate(
      { name: name.trim() },
      {
        onSuccess: (entry) => {
          if (entry) setAddingName(null);
        },
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm">
          You could set a different configuration per{" "}
          <span className="font-medium">{singular}</span> for each MCP server.
          Use this feature if your organization has multiple{" "}
          <span className="font-medium">{plural}</span> and you want each to
          have its own MCP server configuration.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 px-3 text-sm"
            disabled={!canEdit}
            onClick={() => setRenameOpen(true)}
          >
            <Pencil className="h-4 w-4" />
            Rename {singular}
          </Button>
          <Button
            size="sm"
            className="h-9 px-3 text-sm"
            disabled={!canEdit || addingName !== null}
            onClick={() => setAddingName("")}
          >
            <Plus className="h-4 w-4" />
            Add {singular}
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={2}
                  className="text-center text-sm text-muted-foreground"
                >
                  Loading…
                </TableCell>
              </TableRow>
            ) : entries.length === 0 && addingName === null ? (
              <TableRow>
                <TableCell
                  colSpan={2}
                  className="text-center text-sm text-muted-foreground"
                >
                  No {plural} yet.
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="font-medium">{entry.name}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      disabled={!canEdit}
                      onClick={() => setDeleteTarget(entry)}
                      aria-label={`Delete ${entry.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
            {addingName !== null && (
              <TableRow>
                <TableCell colSpan={2}>
                  <Input
                    autoFocus
                    value={addingName}
                    onChange={(e) => setAddingName(e.target.value)}
                    onBlur={() => handleAdd(addingName)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAdd(addingName);
                      } else if (e.key === "Escape") {
                        setAddingName(null);
                      }
                    }}
                    placeholder={`e.g. Production`}
                    disabled={createMutation.isPending}
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <DeleteEntryDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />

      <NameEditorDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        initialSingular={singular}
      />
    </div>
  );
}

function DeleteEntryDialog({
  target,
  onClose,
}: {
  target: McpPresetEntryWithAssignedCount | null;
  onClose: () => void;
}) {
  const deleteMutation = useDeleteMcpPresetEntry();

  if (!target) return null;

  return (
    <DeleteConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${target.name}?`}
      description={
        <div className="space-y-2 text-sm">
          <p>Deleting this entry will:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Remove every per-entry configuration tied to{" "}
              <span className="font-medium">{target.name}</span> across all MCP
              catalog items.
            </li>
            <li>
              Permanently delete the values stored for those configurations,
              including any secrets.
            </li>
          </ul>
          <p>This cannot be undone.</p>
        </div>
      }
      isPending={deleteMutation.isPending}
      pendingLabel="Deleting…"
      onConfirm={() =>
        deleteMutation.mutate(target.id, {
          onSuccess: () => onClose(),
        })
      }
    />
  );
}
