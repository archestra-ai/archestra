"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAppTemplates, useCreateApp } from "@/lib/app.query";

type CreateFormValues = {
  name: string;
  description: string;
};

// Create flow: pick a starter template (the backend resolves it to the seed
// HTML) + name the app. Team scope needs team assignment, so the dialog offers
// personal/org only; re-scoping to a team happens on the detail page.
export function AppCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { data: templates } = useAppTemplates({ enabled: open });
  const createApp = useCreateApp();

  const [templateId, setTemplateId] = useState<string>("blank");
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");

  const form = useForm<CreateFormValues>({
    defaultValues: { name: "", description: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const created = await createApp.mutateAsync({
      name: values.name.trim(),
      description: values.description.trim() || undefined,
      templateId,
      scope,
    });
    if (created) {
      onOpenChange(false);
      form.reset();
      router.push(`/apps/${created.id}`);
    }
  });

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New app"
      description="Start from a template and give your app a name."
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
          <Button type="submit" disabled={createApp.isPending || !templates}>
            {createApp.isPending ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="app-name">Name</Label>
          <Input
            id="app-name"
            placeholder="My app"
            {...form.register("name", { required: true, maxLength: 100 })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="app-description">Description</Label>
          <Textarea
            id="app-description"
            placeholder="What does this app do? (optional)"
            {...form.register("description", { maxLength: 500 })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Template</Label>
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent>
              {(templates ?? []).map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name} — {t.description}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        </div>
      </div>
    </StandardFormDialog>
  );
}
