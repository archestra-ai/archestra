"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { EnvironmentSelector } from "@/components/environment-selector";
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

// Visibility is intentionally absent here — it lives in the Publish dropdown.
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
  const [environmentId, setEnvironmentId] = useState<string | null>(
    app.environmentId ?? null,
  );
  const form = useForm<EditFormValues>({
    defaultValues: { name: app.name, description: app.description ?? "" },
  });

  // Re-seed from server state each time the dialog opens.
  useEffect(() => {
    if (open) {
      form.reset({ name: app.name, description: app.description ?? "" });
      setEnvironmentId(app.environmentId ?? null);
    }
  }, [open, app.name, app.description, app.environmentId, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    const result = await updateApp.mutateAsync({
      appId: app.id,
      body: {
        name: values.name.trim(),
        description: values.description.trim() || null,
        environmentId,
      },
    });
    if (result) onOpenChange(false);
  });

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit"
      description="Update what the model reads and which environment the app runs in."
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

        <EnvironmentSelector
          value={environmentId}
          onChange={setEnvironmentId}
          helpText="The app can only be assigned and call MCP tools in this environment."
        />
      </div>
    </StandardFormDialog>
  );
}
