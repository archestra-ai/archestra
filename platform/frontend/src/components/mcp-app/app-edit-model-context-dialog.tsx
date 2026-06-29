"use client";

import { useForm } from "react-hook-form";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateApp } from "@/lib/app.query";

// Only the identity fields are edited here, so accept the minimal shape shared
// by the full app (detail) and the gallery list item.
type App = { id: string; name: string; description: string | null };

type EditFormValues = {
  name: string;
  description: string;
};

// Name + description are the app's model-facing metadata (what the LLM reads).
// Shared rename/edit dialog for owned apps — used from the app frame's
// address-bar pencil, the settings menu, and the gallery card.
export function AppEditModelContextDialog({
  app,
  open,
  onOpenChange,
  title = "Edit model context",
  description = "What the model reads to decide whether this app is relevant and when to open it.",
}: {
  app: App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Overrides the dialog title for entry points framed differently (e.g. Rename). */
  title?: string;
  description?: string;
}) {
  const updateApp = useUpdateApp();
  const form = useForm<EditFormValues>({
    defaultValues: { name: app.name, description: app.description ?? "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const result = await updateApp.mutateAsync({
      appId: app.id,
      body: {
        name: values.name.trim(),
        description: values.description.trim() || null,
      },
    });
    if (result) onOpenChange(false);
  });

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="medium"
      onSubmit={onSubmit}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={updateApp.isPending}>
            {updateApp.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-app-name">Name</Label>
          <Input
            id="edit-app-name"
            {...form.register("name", { required: true, maxLength: 100 })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="edit-app-description">Description</Label>
          <Textarea
            id="edit-app-description"
            {...form.register("description", { maxLength: 500 })}
          />
        </div>
      </div>
    </StandardFormDialog>
  );
}
