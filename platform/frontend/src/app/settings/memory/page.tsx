"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  SettingsCardHeader,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  type UserMemory,
  useCreateUserMemory,
  useDeleteUserMemory,
  useUpdateUserMemory,
  useUserMemories,
} from "@/lib/user-memory.query";

function MemoryForm({
  initial,
  onSubmit,
  onCancel,
  isPending,
}: {
  initial?: { title: string; content: string };
  onSubmit: (values: { title: string; content: string }) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [content, setContent] = useState(initial?.content ?? "");

  const valid = title.trim().length > 0 && content.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="memory-title">Label</Label>
        <Input
          id="memory-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Preferred language"
          maxLength={200}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="memory-content">Content</Label>
        <Textarea
          id="memory-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="e.g. Always respond in British English"
          maxLength={2000}
          rows={3}
        />
      </div>
      <div className="flex gap-2">
        <Button
          onClick={() => onSubmit({ title: title.trim(), content: content.trim() })}
          disabled={!valid || isPending}
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function MemoryRow({
  memory,
  onEdit,
  onDelete,
}: {
  memory: UserMemory;
  onEdit: (memory: UserMemory) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{memory.title}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{memory.content}</p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Edit"
          onClick={() => onEdit(memory)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:text-destructive"
          title="Delete"
          onClick={() => onDelete(memory.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function MemoryPageContent() {
  const { data: memories, isLoading } = useUserMemories();
  const createMutation = useCreateUserMemory();
  const updateMutation = useUpdateUserMemory();
  const deleteMutation = useDeleteUserMemory();

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<UserMemory | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreate = async (values: { title: string; content: string }) => {
    await createMutation.mutateAsync(values);
    setShowCreate(false);
    toast.success("Memory saved");
  };

  const handleUpdate = async (values: { title: string; content: string }) => {
    if (!editing) return;
    await updateMutation.mutateAsync({ id: editing.id, ...values });
    setEditing(null);
    toast.success("Memory updated");
  };

  const handleDelete = async (id: string) => {
    await deleteMutation.mutateAsync(id);
    setConfirmDeleteId(null);
    toast.success("Memory deleted");
  };

  return (
    <SettingsSectionStack>
      <Card>
        <SettingsCardHeader
          title="Memory"
          description="Notes saved here are included in every conversation so agents can recall your preferences and context."
          action={
            !showCreate && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowCreate(true)}
              >
                <Plus className="h-4 w-4" />
                Add
              </Button>
            )
          }
        />
        <CardContent className="space-y-3">
          {showCreate && (
            <MemoryForm
              onSubmit={handleCreate}
              onCancel={() => setShowCreate(false)}
              isPending={createMutation.isPending}
            />
          )}

          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )}

          {!isLoading && memories?.length === 0 && !showCreate && (
            <p className="text-sm text-muted-foreground">
              No memory entries yet.
            </p>
          )}

          {memories?.map((m) =>
            editing?.id === m.id ? (
              <MemoryForm
                key={m.id}
                initial={{ title: m.title, content: m.content }}
                onSubmit={handleUpdate}
                onCancel={() => setEditing(null)}
                isPending={updateMutation.isPending}
              />
            ) : (
              <MemoryRow
                key={m.id}
                memory={m}
                onEdit={setEditing}
                onDelete={setConfirmDeleteId}
              />
            ),
          )}
        </CardContent>
      </Card>

      <Dialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete memory entry?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This note will no longer be included in conversations. This cannot
            be undone.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDeleteId(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                confirmDeleteId && handleDelete(confirmDeleteId)
              }
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSectionStack>
  );
}

export default function MemorySettingsPage() {
  return (
    <ErrorBoundary>
      <MemoryPageContent />
    </ErrorBoundary>
  );
}
