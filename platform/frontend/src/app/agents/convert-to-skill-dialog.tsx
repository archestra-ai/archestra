import {
  type archestraApiTypes,
  TOOL_ACTIVATE_SKILL_FULL_NAME,
  TOOL_READ_SKILL_FILE_FULL_NAME,
} from "@shared";
import { Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useConvertAgentToSkill,
  useSuggestSkillDescription,
} from "@/lib/agent.query";

type Agent = archestraApiTypes.GetAgentsResponses["200"]["data"][number];

// skill-runtime tools every skill-enabled agent carries; recommending them in a
// skill is circular, so they are excluded (mirrors the backend transform).
const SKILL_RUNTIME_TOOL_NAMES = new Set<string>([
  TOOL_ACTIVATE_SKILL_FULL_NAME,
  TOOL_READ_SKILL_FILE_FULL_NAME,
]);

type ConvertToSkillDialogProps = {
  agent: Agent | null;
  onOpenChange: (open: boolean) => void;
};

type FormValues = {
  description: string;
  deleteAgent: boolean;
};

/**
 * Confirms an agent→skill conversion before it happens. A skill carries
 * instructions only, so this previews what the conversion keeps (the system
 * prompt and an allowed-tools list) versus drops (model, knowledge sources),
 * requires a real description, and offers to remove the now-redundant agent.
 */
export function ConvertToSkillDialog({
  agent,
  onOpenChange,
}: ConvertToSkillDialogProps) {
  const convertToSkill = useConvertAgentToSkill();
  const suggestDescription = useSuggestSkillDescription();

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: { description: "", deleteAgent: false },
  });

  // monotonic token; bumped whenever the dialog switches agent or closes, so an
  // in-flight suggestion that resolves late can detect it is now stale.
  const suggestionToken = useRef(0);

  const onSuggestDescription = async () => {
    if (!agent) return;
    suggestionToken.current += 1;
    const token = suggestionToken.current;
    const descriptionAtRequest = getValues("description");
    const description = await suggestDescription.mutateAsync(agent.id);
    // drop the result if the dialog moved on or the user edited meanwhile.
    if (token !== suggestionToken.current) return;
    if (getValues("description") !== descriptionAtRequest) return;
    if (description) {
      setValue("description", description, { shouldValidate: true });
    }
  };

  // Prefill from the agent each time the dialog opens for a new one, and
  // invalidate any suggestion still in flight for the previous agent.
  useEffect(() => {
    suggestionToken.current += 1;
    if (agent) {
      reset({ description: agent.description ?? "", deleteAgent: false });
    }
  }, [agent, reset]);

  const allowedToolNames =
    agent?.tools
      .filter(
        (tool) =>
          !tool.delegateToAgentId && !SKILL_RUNTIME_TOOL_NAMES.has(tool.name),
      )
      .map((t) => t.name) ?? [];
  const knowledgeCount =
    (agent?.knowledgeBaseIds.length ?? 0) + (agent?.connectorIds.length ?? 0);
  const hasModel = Boolean(agent?.modelId || agent?.llmModel);
  const dropped = [
    hasModel ? "the default model" : null,
    knowledgeCount > 0
      ? `${knowledgeCount} knowledge source${knowledgeCount === 1 ? "" : "s"}`
      : null,
  ].filter((item): item is string => item !== null);

  const onSubmit = handleSubmit(async ({ description, deleteAgent }) => {
    if (!agent) return;
    const result = await convertToSkill.mutateAsync({
      id: agent.id,
      description: description.trim(),
      deleteAgent,
    });
    if (result) onOpenChange(false);
  });

  return (
    <Dialog open={agent !== null} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden">
        <DialogHeader>
          <DialogTitle>Convert to skill</DialogTitle>
          <DialogDescription>
            {agent
              ? `Create a skill from "${agent.name}". It inherits the agent's visibility.`
              : null}
          </DialogDescription>
        </DialogHeader>

        {agent ? (
          <DialogForm
            onSubmit={onSubmit}
            className="flex min-h-0 flex-1 flex-col"
          >
            <DialogBody className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="skill-description">Description</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={onSuggestDescription}
                    disabled={suggestDescription.isPending}
                  >
                    {suggestDescription.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    Generate
                  </Button>
                </div>
                <Textarea
                  id="skill-description"
                  placeholder="What this skill does and when to use it"
                  rows={3}
                  {...register("description", {
                    validate: (value) =>
                      value.trim().length > 0 || "A description is required",
                  })}
                />
                {errors.description ? (
                  <p className="text-destructive text-xs">
                    {errors.description.message}
                  </p>
                ) : null}
              </div>

              {allowedToolNames.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="font-medium text-sm">Allowed tools</p>
                  <p className="text-muted-foreground text-xs">
                    Carried into the skill's <code>allowed-tools</code> so the
                    activating agent knows what to enable:
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {allowedToolNames.map((tool) => (
                      <code
                        key={tool}
                        className="rounded bg-muted px-1.5 py-0.5 text-xs"
                      >
                        {tool}
                      </code>
                    ))}
                  </div>
                </div>
              ) : null}

              {dropped.length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  Won't carry over: {dropped.join(" and ")}. A skill carries
                  instructions only.
                </p>
              ) : null}

              <div className="flex items-start gap-2">
                <Controller
                  control={control}
                  name="deleteAgent"
                  render={({ field }) => (
                    <Checkbox
                      id="delete-agent"
                      checked={field.value}
                      onCheckedChange={(checked) =>
                        field.onChange(checked === true)
                      }
                    />
                  )}
                />
                <div className="space-y-0.5">
                  <Label htmlFor="delete-agent" className="font-normal">
                    Remove the agent after converting
                  </Label>
                  <p className="text-muted-foreground text-xs">
                    The agent is deleted once the skill is created. You can
                    restore it later from the deleted-agents filter.
                  </p>
                </div>
              </div>
            </DialogBody>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={convertToSkill.isPending}>
                {convertToSkill.isPending
                  ? "Converting..."
                  : "Convert to skill"}
              </Button>
            </DialogFooter>
          </DialogForm>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
