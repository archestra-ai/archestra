"use client";

import { useEffect } from "react";
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

// Visibility and environment are managed from the app's MCP registry card; this
// dialog edits only the app's own identity (name + description).
export function AppEditConfigDialog({
  app,
  open,
  onOpenChange,
}: {
  app: App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateApp = useUpdateApp();
  const form = useForm<EditFormValues>({
    defaultValues: { name: app.name, description: app.description ?? "" },
  });

  // Re-seed from server state each time the dialog opens.
  useEffect(() => {
    if (open) {
      form.reset({ name: app.name, description: app.description ?? "" });
    }
  }, [open, app.name, app.description, form]);

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
      title="Edit"
      description="Update the app's name and description."
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
