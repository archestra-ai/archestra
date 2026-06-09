"use client";

import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { parseRequirementsInput } from "@/lib/agent-hooks-editor.requirements";
import { useFeature } from "@/lib/config/config.query";
import {
  type AgentHook,
  type HookEvent,
  useAgentHooks,
  useCreateHook,
  useDeleteHook,
  useUpdateHook,
} from "@/lib/hook.query";

const HOOK_EVENTS: { value: HookEvent; label: string }[] = [
  { value: "session_start", label: "Session start" },
  { value: "pre_tool_use", label: "Pre tool use" },
  { value: "post_tool_use", label: "Post tool use" },
];

const EVENT_LABELS: Record<HookEvent, string> = Object.fromEntries(
  HOOK_EVENTS.map((e) => [e.value, e.label]),
) as Record<HookEvent, string>;

const FILE_NAME_REGEX = /\.(py|sh)$/;

function isPythonHook(fileName: string): boolean {
  return fileName.trim().toLowerCase().endsWith(".py");
}

export function AgentHooksEditor({ agentId }: { agentId: string }) {
  const sandboxEnabled = useFeature("sandbox");

  // Hooks only execute when the sandbox runtime is enabled; hide the editor
  // entirely otherwise. Gate before mounting the inner component so its data
  // and mutation queries don't run when the feature is off.
  if (!sandboxEnabled) {
    return null;
  }

  return <AgentHooksEditorContent agentId={agentId} />;
}

function AgentHooksEditorContent({ agentId }: { agentId: string }) {
  const { data: hooks = [], isLoading } = useAgentHooks(agentId);
  const updateHook = useUpdateHook(agentId);
  const deleteHook = useDeleteHook(agentId);

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Hooks ({hooks.length})</h3>
          <p className="text-xs text-muted-foreground">
            Run a script in the sandbox when a lifecycle event fires.
          </p>
        </div>
        <AddHookDialog agentId={agentId} />
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading hooks...</p>
      ) : hooks.length === 0 ? (
        <p className="text-xs text-muted-foreground">No hooks yet.</p>
      ) : (
        <div className="space-y-2">
          {hooks.map((hook) => (
            <div
              key={hook.id}
              className="flex items-center gap-3 rounded-md border p-3"
            >
              <Badge variant="secondary">{EVENT_LABELS[hook.event]}</Badge>
              <code className="flex-1 truncate text-xs">{hook.fileName}</code>
              <div className="flex items-center gap-2">
                <EditHookDialog agentId={agentId} hook={hook} />
                <Switch
                  checked={hook.enabled}
                  disabled={updateHook.isPending}
                  onCheckedChange={(checked) =>
                    updateHook.mutate({ id: hook.id, enabled: checked })
                  }
                  aria-label={`Toggle ${hook.fileName}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  disabled={deleteHook.isPending}
                  onClick={() => deleteHook.mutate(hook.id)}
                  aria-label={`Delete ${hook.fileName}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddHookDialog({ agentId }: { agentId: string }) {
  const createHook = useCreateHook(agentId);
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<HookEvent>("session_start");
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");
  const [requirements, setRequirements] = useState("");

  const showRequirements = isPythonHook(fileName);

  const resetForm = () => {
    setEvent("session_start");
    setFileName("");
    setContent("");
    setRequirements("");
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      resetForm();
    }
  };

  const handleSubmit = async () => {
    const trimmedFileName = fileName.trim();
    if (!FILE_NAME_REGEX.test(trimmedFileName)) {
      toast.error("File name must end in .py or .sh");
      return;
    }
    if (!content.trim()) {
      toast.error("Content is required");
      return;
    }

    const input: Parameters<typeof createHook.mutate>[0] = {
      agentId,
      event,
      fileName: trimmedFileName,
      content,
      ...(showRequirements
        ? { requirements: parseRequirementsInput(requirements) }
        : {}),
    };

    const created = await createHook.mutateAsync(input);
    if (created) {
      handleOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Add hook
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add hook</DialogTitle>
        </DialogHeader>

        <HookFormFields
          event={event}
          onEventChange={setEvent}
          fileName={fileName}
          onFileNameChange={setFileName}
          content={content}
          onContentChange={setContent}
          requirements={requirements}
          onRequirementsChange={setRequirements}
        />

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={createHook.isPending}
          >
            {createHook.isPending && (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            )}
            Add hook
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface HookFormFieldsProps {
  event: HookEvent;
  onEventChange: (event: HookEvent) => void;
  fileName: string;
  onFileNameChange: (fileName: string) => void;
  content: string;
  onContentChange: (content: string) => void;
  requirements: string;
  onRequirementsChange: (requirements: string) => void;
}

/** Shared form body for the add and edit hook dialogs. */
function HookFormFields({
  event,
  onEventChange,
  fileName,
  onFileNameChange,
  content,
  onContentChange,
  requirements,
  onRequirementsChange,
}: HookFormFieldsProps) {
  const showRequirements = isPythonHook(fileName);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="hook-event">Event</Label>
        <Select
          value={event}
          onValueChange={(value) => onEventChange(value as HookEvent)}
        >
          <SelectTrigger id="hook-event">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HOOK_EVENTS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="hook-file-name">File name</Label>
        <Input
          id="hook-file-name"
          value={fileName}
          onChange={(e) => onFileNameChange(e.target.value)}
          placeholder="e.g. notify.py or check.sh"
        />
        <p className="text-xs text-muted-foreground">
          Must end in <code>.py</code> or <code>.sh</code>.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="hook-content">Content</Label>
        <Textarea
          id="hook-content"
          value={content}
          onChange={(e) => onContentChange(e.target.value)}
          placeholder="The script to run when the event fires"
          className="min-h-[160px] font-mono text-xs"
        />
      </div>

      {showRequirements && (
        <div className="space-y-2">
          <Label htmlFor="hook-requirements">Requirements</Label>
          <Textarea
            id="hook-requirements"
            value={requirements}
            onChange={(e) => onRequirementsChange(e.target.value)}
            placeholder="One per line or comma-separated, e.g. requests, httpx"
            className="min-h-[60px] font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            Python dependencies installed before the hook runs.
          </p>
        </div>
      )}
    </div>
  );
}

function EditHookDialog({
  agentId,
  hook,
}: {
  agentId: string;
  hook: AgentHook;
}) {
  const updateHook = useUpdateHook(agentId);
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<HookEvent>(hook.event);
  const [fileName, setFileName] = useState(hook.fileName);
  const [content, setContent] = useState(hook.content);
  const [requirements, setRequirements] = useState(
    hook.requirements.join("\n"),
  );

  // Re-sync the form from the latest hook each time the dialog opens, so a
  // reused row dialog never shows stale values after an external change.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setEvent(hook.event);
      setFileName(hook.fileName);
      setContent(hook.content);
      setRequirements(hook.requirements.join("\n"));
    }
  };

  const handleSubmit = async () => {
    const trimmedFileName = fileName.trim();
    if (!FILE_NAME_REGEX.test(trimmedFileName)) {
      toast.error("File name must end in .py or .sh");
      return;
    }
    if (!content.trim()) {
      toast.error("Content is required");
      return;
    }

    const updated = await updateHook.mutateAsync({
      id: hook.id,
      event,
      fileName: trimmedFileName,
      content,
      requirements: isPythonHook(trimmedFileName)
        ? parseRequirementsInput(requirements)
        : [],
    });
    if (updated) {
      setOpen(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          aria-label={`Edit ${hook.fileName}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit hook</DialogTitle>
        </DialogHeader>

        <HookFormFields
          event={event}
          onEventChange={setEvent}
          fileName={fileName}
          onFileNameChange={setFileName}
          content={content}
          onContentChange={setContent}
          requirements={requirements}
          onRequirementsChange={setRequirements}
        />

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={updateHook.isPending}
          >
            {updateHook.isPending && (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
