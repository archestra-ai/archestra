"use client";

import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "@archestra/shared";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { IdentityFields } from "@/components/identity-fields";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCreateProjectFromConversation } from "@/lib/projects/projects.query";

type CreateProjectFromChatForm = {
  name: string;
  description: string;
  icon: string | null;
};

/**
 * Turns a chat into a project. Prefilled with the chat's title; on submit it
 * creates the project, moves the chat (and its files) into it, and navigates to
 * the new project. Mirrors the projects page "New project" dialog.
 */
export function CreateProjectFromChatDialog({
  conversationId,
  defaultName,
  open,
  onOpenChange,
}: {
  conversationId: string | null;
  defaultName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const form = useForm<CreateProjectFromChatForm>({
    defaultValues: { name: defaultName, description: "", icon: null },
    mode: "onChange",
  });
  const createFromChat = useCreateProjectFromConversation();
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const icon = form.watch("icon");
  const name = form.watch("name");
  const description = form.watch("description");
  const hasLengthError =
    name.length > PROJECT_NAME_MAX_LENGTH ||
    description.length > PROJECT_DESCRIPTION_MAX_LENGTH;

  // The same dialog instance is reused across chats, so refresh the prefilled
  // name each time it opens for a different conversation.
  useEffect(() => {
    if (open) {
      form.reset({ name: defaultName, description: "", icon: null });
      setLabels([]);
    }
  }, [open, defaultName, form]);

  const onSubmit = form.handleSubmit(async ({ name, description, icon }) => {
    if (!conversationId) return;
    const nextLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    const project = await createFromChat.mutateAsync({
      conversationId,
      name: name.trim(),
      description: description.trim() || null,
      icon,
      labels: nextLabels,
    });
    if (project) {
      onOpenChange(false);
      router.push(`/projects/${project.id}`);
    }
  });

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create project from chat"
      description="This chat and its files move into the new project. Files the agent saves here are kept together and show up in your files."
      size="medium"
      isDirty={form.formState.isDirty || labels.length > 0}
      onSubmit={onSubmit}
      bodyClassName="space-y-4"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              createFromChat.isPending || !name.trim().length || hasLengthError
            }
          >
            Create
          </Button>
        </>
      }
    >
      <IdentityFields
        icon={icon}
        onIconChange={(next) => form.setValue("icon", next)}
        fallbackType="project"
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="chat-project-name">Name *</Label>
            <Input
              autoFocus
              id="chat-project-name"
              maxLength={PROJECT_NAME_MAX_LENGTH}
              aria-invalid={!!form.formState.errors.name}
              {...form.register("name", {
                required: "Project name is required.",
                maxLength: {
                  value: PROJECT_NAME_MAX_LENGTH,
                  message: `Project name must be ${PROJECT_NAME_MAX_LENGTH} characters or fewer.`,
                },
              })}
            />
            {form.formState.errors.name?.message && (
              <p className="text-xs text-destructive">
                {form.formState.errors.name.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="chat-project-description">Description</Label>
            <Textarea
              id="chat-project-description"
              placeholder="What is this project about?"
              rows={3}
              maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
              aria-invalid={!!form.formState.errors.description}
              {...form.register("description", {
                maxLength: {
                  value: PROJECT_DESCRIPTION_MAX_LENGTH,
                  message: `Description must be ${PROJECT_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
                },
              })}
            />
            {form.formState.errors.description?.message && (
              <p className="text-xs text-destructive">
                {form.formState.errors.description.message}
              </p>
            )}
          </div>
        </div>
      </IdentityFields>
      <AdvancedLabelsSection
        ref={labelsRef}
        labels={labels}
        onLabelsChange={setLabels}
      />
    </StandardFormDialog>
  );
}
