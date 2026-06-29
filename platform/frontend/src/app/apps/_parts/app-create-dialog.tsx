"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCreateApp } from "@/lib/app.query";
import { buildAppChatHandoffUrl } from "@/lib/apps/app-chat-handoff";

type CreateFormValues = {
  name: string;
};

// Seeded as the new app's description so the blank scaffold has a get-started
// hint to show until the app is built out.
const DEFAULT_APP_DESCRIPTION =
  "To get started, send a prompt describing what you want to build.";

// Create flow: just name the app. It's created as a blank personal app the user
// builds out in chat; visibility, environment, and a real description are set
// later from the app's settings.
export function AppCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const createApp = useCreateApp();

  const form = useForm<CreateFormValues>({
    defaultValues: { name: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const created = await createApp.mutateAsync({
      name: values.name.trim(),
      description: DEFAULT_APP_DESCRIPTION,
    });
    if (created) {
      onOpenChange(false);
      form.reset();
      router.push(
        buildAppChatHandoffUrl({
          appId: created.id,
          appName: values.name.trim(),
        }),
      );
    }
  });

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New app"
      description="This creates a blank app and opens it in chat, where you can start building."
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
          <Button type="submit" disabled={createApp.isPending}>
            {createApp.isPending ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="app-name">Name</Label>
        <Input
          id="app-name"
          placeholder="e.g. Sales dashboard, Task tracker, Content calendar"
          {...form.register("name", { required: true, maxLength: 100 })}
        />
      </div>
    </StandardFormDialog>
  );
}
