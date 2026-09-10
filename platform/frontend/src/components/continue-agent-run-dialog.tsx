"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useContinueAgentRun } from "@/lib/agent-runtime.query";

export function ContinueAgentRunDialog({
  taskId,
  open,
  onOpenChange,
}: {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const continuation = useContinueAgentRun();
  const form = useForm({ defaultValues: { message: "" } });
  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Resume conversation"
      description="Reopen the saved conversation in an interactive terminal. A suspended workspace starts up first."
      onSubmit={form.handleSubmit(({ message }) =>
        continuation.mutate(
          { taskId, message },
          {
            onSuccess: (result) => {
              if (!result) return;
              form.reset();
              onOpenChange(false);
              router.push(`/chat/runs/${result.sessionId ?? taskId}`);
            },
          },
        ),
      )}
      bodyClassName="space-y-2"
      footer={
        <Button
          type="submit"
          disabled={continuation.isPending || !form.watch("message").trim()}
        >
          <span>{continuation.isPending ? "Starting…" : "Continue"}</span>
        </Button>
      }
    >
      <Label htmlFor="continuation-message">
        What should the Agent do next?
      </Label>
      <Textarea
        id="continuation-message"
        autoFocus
        rows={4}
        {...form.register("message", { required: true })}
      />
    </StandardFormDialog>
  );
}
