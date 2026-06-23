"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { EnvironmentSelector } from "@/components/environment-selector";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateApp } from "@/lib/app.query";

type App = archestraApiTypes.GetAppResponses["200"];

export function AppSettingsForm({ app }: { app: App }) {
  const updateApp = useUpdateApp();
  const [scope, setScope] = useState<ResourceVisibilityScope>(app.scope);
  const [environmentId, setEnvironmentId] = useState<string | null>(
    app.environmentId ?? null,
  );
  const form = useForm({
    defaultValues: {
      name: app.name,
      description: app.description ?? "",
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    await updateApp.mutateAsync({
      appId: app.id,
      body: {
        name: values.name.trim(),
        description: values.description.trim() || null,
        scope,
        environmentId,
      },
    });
  });

  return (
    <form onSubmit={onSubmit} className="flex max-w-xl flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-name">Name</Label>
        <Input
          id="settings-name"
          {...form.register("name", { required: true, maxLength: 100 })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-description">Description</Label>
        <Textarea
          id="settings-description"
          {...form.register("description", { maxLength: 500 })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Visibility</Label>
        <Select
          value={scope}
          onValueChange={(v) => setScope(v as ResourceVisibilityScope)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="personal">Personal — only you</SelectItem>
            <SelectItem value="org">Organization — everyone</SelectItem>
          </SelectContent>
        </Select>
        {app.scope === "team" ? (
          <p className="text-xs text-muted-foreground">
            This app is shared with a team. Changing the visibility here removes
            team sharing.
          </p>
        ) : null}
      </div>

      <EnvironmentSelector
        value={environmentId}
        onChange={setEnvironmentId}
        helpText="The app can only be assigned and call MCP tools in this environment."
      />

      <div>
        <PermissionButton
          type="submit"
          permissions={{ app: ["update"] }}
          disabled={updateApp.isPending}
        >
          {updateApp.isPending ? "Saving…" : "Save"}
        </PermissionButton>
      </div>
    </form>
  );
}
