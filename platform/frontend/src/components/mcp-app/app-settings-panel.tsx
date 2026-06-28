"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { AppDeleteDialog } from "@/app/apps/_parts/app-delete-dialog";
import { AppToolsEditor } from "@/app/apps/_parts/app-tools-editor";
import { EnvironmentSelector } from "@/components/environment-selector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateApp } from "@/lib/app.query";
import { useHasPermissions } from "@/lib/auth/auth.query";

type App = archestraApiTypes.GetAppResponses["200"];

type SettingsFormValues = {
  name: string;
  description: string;
};

// Settings tab for the owned-app side panel: the app's model-facing metadata
// (name + description), its bound environment, its enabled MCP tools, and a
// destructive delete section. Each section writes through the Apps API
// independently; the tools editor auto-persists every toggle on its own.
export function AppSettingsPanel({ app }: { app: App }) {
  const updateApp = useUpdateApp();
  const { data: canUpdate } = useHasPermissions({ app: ["update"] });
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
  const [deleteOpen, setDeleteOpen] = useState(false);

  const form = useForm<SettingsFormValues>({
    defaultValues: { name: app.name, description: app.description ?? "" },
  });

  // Keep the form in sync when the app refetches (e.g. after saving).
  useEffect(() => {
    form.reset({ name: app.name, description: app.description ?? "" });
  }, [app.name, app.description, form]);

  const readOnly = canUpdate !== true;

  const onSubmit = form.handleSubmit(async (values) => {
    await updateApp.mutateAsync({
      appId: app.id,
      body: {
        name: values.name.trim(),
        description: values.description.trim() || null,
      },
    });
  });

  const handleEnvironmentChange = (environmentId: string | null) => {
    updateApp.mutate({ appId: app.id, body: { environmentId } });
  };

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="app-settings-name">Name</Label>
          <Input
            id="app-settings-name"
            disabled={readOnly}
            {...form.register("name", { required: true, maxLength: 100 })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="app-settings-description">Description</Label>
          <Textarea
            id="app-settings-description"
            disabled={readOnly}
            {...form.register("description", { maxLength: 500 })}
          />
          <p className="text-xs text-muted-foreground">
            What the model reads to decide whether this app is relevant and when
            to open it.
          </p>
        </div>
        {!readOnly && (
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={updateApp.isPending || !form.formState.isDirty}
            >
              {updateApp.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </form>

      {!readOnly && (
        <EnvironmentSelector
          value={app.environmentId ?? null}
          onChange={handleEnvironmentChange}
          helpText="The app can only be assigned and call MCP tools in this environment."
        />
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Tools</h3>
        <AppToolsEditor appId={app.id} />
      </div>

      {canDelete && (
        <section className="space-y-2 border-t pt-6">
          <h3 className="text-sm font-semibold text-destructive">Delete app</h3>
          <p className="text-xs text-muted-foreground">
            Permanently delete this app and its version history. This cannot be
            undone.
          </p>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setDeleteOpen(true)}
          >
            Delete app
          </Button>
          <AppDeleteDialog
            app={app}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
          />
        </section>
      )}
    </div>
  );
}
