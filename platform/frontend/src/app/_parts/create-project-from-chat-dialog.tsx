"use client";

import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "@archestra/shared";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    }
  }, [open, defaultName, form]);

  const onSubmit = form.handleSubmit(async ({ name, description, icon }) => {
    if (!conversationId) return;
    const project = await createFromChat.mutateAsync({
      conversationId,
      name: name.trim(),
      description: description.trim() || null,
      icon,
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
      size="small"
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
      <div className="flex items-start gap-3">
        <AgentIconPicker
          value={icon}
          onChange={(next) => form.setValue("icon", next)}
          fallbackType="project"
        />
        <div className="flex-1 space-y-3 min-w-0">
          <Input
            autoFocus
            placeholder="Project name"
            aria-label="Project name"
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
          <Textarea
            placeholder="Description (optional)"
            aria-label="Project description"
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
    </StandardFormDialog>
  );
}
