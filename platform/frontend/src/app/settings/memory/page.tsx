"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { SettingsSectionStack } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import {
  type MemoryItem,
  useCreateMemoryItem,
  useDeleteMemoryItem,
  useMemoryItems,
  useUpdateMemoryItem,
} from "@/lib/memory-item.query";
import { useSetSettingsAction } from "../layout";

function MemoryItemForm({
  defaultContent,
  defaultNamespace,
  onSubmit,
  isPending,
  onCancel,
}: {
  defaultContent?: string;
  defaultNamespace?: string;
  onSubmit: (data: { content: string; namespace?: string }) => void;
  isPending: boolean;
  onCancel: () => void;
}) {
  const [content, setContent] = useState(defaultContent ?? "");
  const [namespace, setNamespace] = useState(defaultNamespace ?? "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    onSubmit({
      content: content.trim(),
      namespace: namespace.trim() || undefined,
    });
  };

  return (
    <DialogForm onSubmit={handleSubmit}>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="memory-content">Content</Label>
          <Textarea
            id="memory-content"
            placeholder="What should the agent remember?"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="memory-namespace">
            Namespace{" "}
            <span className="text-muted-foreground font-normal">(optional)</span>
          </Label>
          <Input
            id="memory-namespace"
            placeholder="e.g. project, preferences, facts"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
          />
        </div>
      </div>
      <DialogStickyFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!content.trim() || isPending}>
          Save
        </Button>
      </DialogStickyFooter>
    </DialogForm>
  );
}

function MemoryItemCard({
  item,
  onEdit,
  onDelete,
}: {
  item: MemoryItem;
  onEdit: (item: MemoryItem) => void;
  onDelete: (item: MemoryItem) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {item.namespace && (
              <span className="inline-block rounded bg-muted px-2 py-0.5 text-xs font-medium mb-1">
                {item.namespace}
              </span>
            )}
            <CardDescription className="text-sm whitespace-pre-wrap break-words">
              {item.content}
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onEdit(item)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive"
              onClick={() => onDelete(item)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

function MemoryContent() {
  const setActionButton = useSetSettingsAction();
  const { data: items = [], isPending } = useMemoryItems();
  const createMutation = useCreateMemoryItem();
  const updateMutation = useUpdateMemoryItem();
  const deleteMutation = useDeleteMemoryItem();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<MemoryItem | null>(null);
  const [deletingItem, setDeletingItem] = useState<MemoryItem | null>(null);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ memoryItem: ["create"] }}
        onClick={() => setIsCreateOpen(true)}
      >
        <Plus className="h-4 w-4" />
        Add Memory
      </PermissionButton>,
    );
    return () => setActionButton(null);
  }, [setActionButton]);

  const handleCreate = async (data: { content: string; namespace?: string }) => {
    await createMutation.mutateAsync(data);
    setIsCreateOpen(false);
  };

  const handleUpdate = async (data: { content: string; namespace?: string }) => {
    if (!editingItem) return;
    await updateMutation.mutateAsync({ id: editingItem.id, ...data });
    setEditingItem(null);
  };

  const handleDelete = async () => {
    if (!deletingItem) return;
    await deleteMutation.mutateAsync(deletingItem.id);
    setDeletingItem(null);
  };

  return (
    <div className="space-y-6">
      <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
        {items.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No memories yet</CardTitle>
              <CardDescription>
                Memories let the agent remember important details across
                conversations. Add one to get started.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <SettingsSectionStack>
            {items.map((item) => (
              <MemoryItemCard
                key={item.id}
                item={item}
                onEdit={setEditingItem}
                onDelete={setDeletingItem}
              />
            ))}
          </SettingsSectionStack>
        )}
      </LoadingWrapper>

      {/* Create dialog */}
      <FormDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        title="Add Memory"
        description="Save something for the agent to remember."
        size="small"
      >
        <MemoryItemForm
          onSubmit={handleCreate}
          isPending={createMutation.isPending}
          onCancel={() => setIsCreateOpen(false)}
        />
      </FormDialog>

      {/* Edit dialog */}
      <FormDialog
        open={!!editingItem}
        onOpenChange={(open) => !open && setEditingItem(null)}
        title="Edit Memory"
        size="small"
      >
        {editingItem && (
          <MemoryItemForm
            defaultContent={editingItem.content}
            defaultNamespace={editingItem.namespace ?? undefined}
            onSubmit={handleUpdate}
            isPending={updateMutation.isPending}
            onCancel={() => setEditingItem(null)}
          />
        )}
      </FormDialog>

      {/* Delete confirmation */}
      <DeleteConfirmDialog
        open={!!deletingItem}
        onOpenChange={(open) => !open && setDeletingItem(null)}
        title="Delete Memory"
        description="This memory will be permanently removed."
        isPending={deleteMutation.isPending}
        onConfirm={handleDelete}
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />
    </div>
  );
}

export default function MemorySettingsPage() {
  return (
    <ErrorBoundary>
      <MemoryContent />
    </ErrorBoundary>
  );
}
