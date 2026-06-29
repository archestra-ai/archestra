"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useForm } from "react-hook-form";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateApp } from "@/lib/app.query";

type App = archestraApiTypes.GetAppResponses["200"];

type EditFormValues = {
  name: string;
  description: string;
};

// Name + description are the app's model-facing metadata (what the LLM reads).
// This is the trimmed variant of AppEditConfigDialog without the environment
// selector — used from the app frame's address-bar pencil.
export function AppEditModelContextDialog({
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
      title="Edit model context"
      description="What the model reads to decide whether this app is relevant and when to open it."
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
