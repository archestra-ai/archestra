"use client";

import { AppWindow } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  type InitialPermissionGrant,
  InitialResourcePermissions,
} from "@/components/initial-resource-permissions";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useCreateApp } from "@/lib/app.query";
import { appRunUrl } from "@/lib/apps/app-run-url";

type CreateFormValues = {
  name: string;
  initialGrants: InitialPermissionGrant[];
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
  const [activeSection, setActiveSection] = useState<"general" | "permissions">(
    "general",
  );

  useEffect(() => {
    if (open) setActiveSection("general");
  }, [open]);

  const form = useForm<CreateFormValues>({
    defaultValues: { name: "", initialGrants: [] },
  });

  const handleOpenChange = (next: boolean) => {
    // Clear any typed-but-uncommitted name when the dialog is dismissed.
    if (!next) form.reset();
    onOpenChange(next);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    // One round-trip: the backend creates the app, seeds a conversation with it
    // already rendered, and returns the conversation id to open directly.
    const created = await createApp.mutateAsync({
      name: values.name.trim(),
      description: DEFAULT_APP_DESCRIPTION,
      openInChat: true,
      initialGrants: values.initialGrants.map(({ subject, actions }) => ({
        subject,
        actions,
      })),
    });
    if (created) {
      handleOpenChange(false);
      // Seeding is best-effort; if it was skipped (e.g. no LLM configured), open
      // the app's standalone page instead of a chat.
      router.push(
        created.conversationId
          ? `/chat/${created.conversationId}`
          : appRunUrl(created),
      );
    }
  });

  return (
    <TabbedDialogShell
      open={open}
      onOpenChange={handleOpenChange}
      title="New app"
      description="This creates a blank app and opens it in chat, where you can start building."
      sidebarLabel={form.watch("name") || "New app"}
      sidebarDescription="App"
      sidebarIcon={<AppWindow className="h-4 w-4 text-muted-foreground" />}
      activeSection={activeSection}
      navItems={[
        { id: "general", label: "General" },
        { id: "permissions", label: "Permissions" },
      ]}
      onActiveSectionChange={setActiveSection}
      isDirty={form.formState.isDirty}
      onSubmit={onSubmit}
      footer={
        <>
          <DialogCancelButton />
          <Button type="submit" disabled={createApp.isPending}>
            {createApp.isPending ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div
        hidden={activeSection !== "general"}
        className="flex flex-col gap-1.5"
      >
        <Label htmlFor="app-name">Name</Label>
        <Input
          id="app-name"
          placeholder="e.g. Sales dashboard, Task tracker, Content calendar"
          aria-invalid={!!form.formState.errors.name}
          {...form.register("name", {
            required: "Name is required.",
            maxLength: {
              value: 100,
              message: "Name must be 100 characters or fewer.",
            },
            validate: (value) => value.trim().length > 0 || "Name is required.",
          })}
        />
        {form.formState.errors.name?.message ? (
          <p className="text-xs text-destructive">
            {form.formState.errors.name.message}
          </p>
        ) : null}
      </div>
      <div hidden={activeSection !== "permissions"}>
        <InitialResourcePermissions
          resource="app"
          grants={form.watch("initialGrants")}
          onChange={(initialGrants) =>
            form.setValue("initialGrants", initialGrants, { shouldDirty: true })
          }
          standalone
        />
      </div>
    </TabbedDialogShell>
  );
}
