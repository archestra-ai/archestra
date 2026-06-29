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

// The owned-app side panel's "All settings" view: name/description and the
// bound environment commit together behind a single Save. Below that sit the
// live tools editor (auto-persists each toggle) and the destructive delete
// section. Visibility lives in its own header dropdown (AppVisibilityButton).
export function AppSettingsPanel({ app }: { app: App }) {
  const updateApp = useUpdateApp();
  const { data: canUpdate } = useHasPermissions({ app: ["update"] });
  const { data: canDelete } = useHasPermissions({ app: ["delete"] });
  const [deleteOpen, setDeleteOpen] = useState(false);

  const form = useForm<SettingsFormValues>({
    defaultValues: { name: app.name, description: app.description ?? "" },
  });

  const [environmentId, setEnvironmentId] = useState<string | null>(
    app.environmentId ?? null,
  );

  // Re-seed every field from server state whenever the app refetches (e.g. after
  // a save) so the form and the environment control stay in sync.
  useEffect(() => {
    form.reset({ name: app.name, description: app.description ?? "" });
    setEnvironmentId(app.environmentId ?? null);
  }, [app.name, app.description, app.environmentId, form]);

  const readOnly = canUpdate !== true;
  const isDirty =
    form.formState.isDirty ||
    (environmentId ?? null) !== (app.environmentId ?? null);

  const onSubmit = form.handleSubmit(async (values) => {
    await updateApp.mutateAsync({
      appId: app.id,
      body: {
        name: values.name.trim(),
        description: values.description.trim() || null,
        environmentId,
      },
    });
  });

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
          <EnvironmentSelector
            value={environmentId}
            onChange={setEnvironmentId}
            helpText="The app can only be assigned and call MCP tools in this environment."
          />
        )}

        {!readOnly && (
          <div className="flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={updateApp.isPending || !isDirty}
            >
              {updateApp.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </form>

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
