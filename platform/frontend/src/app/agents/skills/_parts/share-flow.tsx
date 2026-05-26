"use client";

import { urlSlugify } from "@shared";
import { AlertTriangle, Check, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useCreateSkillShareLink,
  useRevokeSkillShareLink,
} from "@/lib/skills/skill-share.query";
import { cn } from "@/lib/utils";
import {
  computeExpiresAt,
  SHARE_CLIENTS,
  SHARE_TTL_PRESETS,
  type ShareClient,
  type ShareInstallStep,
} from "./share-clients";

type ClientChoice = "claude-code" | "codex" | "both";

interface ShareFlowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skill: { id: string; name: string };
}

interface CreatedShare {
  linkId: string;
  cloneUrl: string;
  marketplaceName: string;
}

export function ShareFlow({ open, onOpenChange, skill }: ShareFlowProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [clientChoice, setClientChoice] = useState<ClientChoice>("claude-code");
  const [name, setName] = useState("");
  const [ttlId, setTtlId] = useState<string>(SHARE_TTL_PRESETS[0].id);
  const [created, setCreated] = useState<CreatedShare | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const createShare = useCreateSkillShareLink();
  const revokeShare = useRevokeSkillShareLink();
  const appName = useAppName();

  const skillSlug = useMemo(
    () => urlSlugify(skill.name) || `skill-${skill.id.slice(0, 8)}`,
    [skill.id, skill.name],
  );

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setStep(1);
        setClientChoice("claude-code");
        setName("");
        setTtlId(SHARE_TTL_PRESETS[0].id);
        setCreated(null);
        setConfirmRevoke(false);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const handleCreate = useCallback(async () => {
    const preset =
      SHARE_TTL_PRESETS.find((p) => p.id === ttlId) ?? SHARE_TTL_PRESETS[0];
    const result = await createShare.mutateAsync({
      skillIds: [skill.id],
      name: name.trim() ? name.trim() : undefined,
      expiresAt: computeExpiresAt(preset.days),
    });
    if (result) {
      setCreated({
        linkId: result.link.id,
        cloneUrl: result.cloneUrl,
        marketplaceName: result.marketplaceName,
      });
      setStep(3);
    }
  }, [createShare, name, skill.id, ttlId]);

  const handleRevoke = useCallback(async () => {
    if (!created) return;
    const result = await revokeShare.mutateAsync(created.linkId);
    if (result) {
      handleClose(false);
    }
  }, [created, handleClose, revokeShare]);

  const selectedClients: ShareClient[] = useMemo(() => {
    if (clientChoice === "both") return SHARE_CLIENTS;
    return SHARE_CLIENTS.filter((c) => c.id === clientChoice);
  }, [clientChoice]);

  return (
    <StandardDialog
      open={open}
      onOpenChange={handleClose}
      size="medium"
      title={`Share "${skill.name}"`}
      description={`Generate an install link that lets a teammate add this skill to their ${appName} marketplace from Claude Code or Codex.`}
      footer={
        <ShareFlowFooter
          step={step}
          onBack={() => setStep((s) => (s === 1 ? 1 : ((s - 1) as 1 | 2)))}
          onNext={() => setStep((s) => (s === 1 ? 2 : s))}
          onCreate={handleCreate}
          onClose={() => handleClose(false)}
          isCreating={createShare.isPending}
          isRevoking={revokeShare.isPending}
          canRevoke={!!created}
          confirmRevoke={confirmRevoke}
          onRequestRevoke={() => setConfirmRevoke(true)}
          onCancelRevoke={() => setConfirmRevoke(false)}
          onConfirmRevoke={handleRevoke}
        />
      }
    >
      <div className="flex flex-col gap-6">
        <StepIndicator current={step} />

        {step === 1 && (
          <ClientPickerStep value={clientChoice} onChange={setClientChoice} />
        )}
        {step === 2 && (
          <NameAndTtlStep
            name={name}
            onNameChange={setName}
            ttlId={ttlId}
            onTtlChange={setTtlId}
          />
        )}
        {step === 3 && created && (
          <InstallSnippetsStep
            clients={selectedClients}
            cloneUrl={created.cloneUrl}
            marketplaceName={created.marketplaceName}
            skillSlug={skillSlug}
          />
        )}
      </div>
    </StandardDialog>
  );
}

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  const labels: { id: 1 | 2 | 3; label: string }[] = [
    { id: 1, label: "Pick client" },
    { id: 2, label: "Configure link" },
    { id: 3, label: "Install" },
  ];
  return (
    <ol className="flex items-center gap-2 text-xs text-muted-foreground">
      {labels.map(({ id, label }, idx) => {
        const isDone = id < current;
        const isActive = id === current;
        return (
          <li key={id} className="flex items-center gap-2">
            <span
              data-testid={`share-step-pill-${id}`}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-medium",
                isActive && "border-primary bg-primary text-primary-foreground",
                isDone && "border-primary/40 bg-primary/10 text-primary",
                !isActive && !isDone && "border-border",
              )}
            >
              {isDone ? <Check className="h-3 w-3" /> : id}
            </span>
            <span
              className={cn(
                isActive && "font-medium text-foreground",
                isDone && "text-foreground",
              )}
            >
              {label}
            </span>
            {idx < labels.length - 1 && (
              <span className="mx-1 h-px w-6 bg-border" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ClientPickerStep({
  value,
  onChange,
}: {
  value: ClientChoice;
  onChange: (v: ClientChoice) => void;
}) {
  const choices: { id: ClientChoice; label: string; sub: string }[] = [
    { id: "claude-code", label: "Claude Code", sub: "Anthropic CLI" },
    { id: "codex", label: "Codex", sub: "OpenAI CLI" },
    { id: "both", label: "Both", sub: "Show install snippets for each" },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm font-medium">
        Which client do you want to share with?
      </div>
      <div className="grid gap-2">
        {choices.map((choice) => (
          <button
            type="button"
            key={choice.id}
            onClick={() => onChange(choice.id)}
            data-testid={`share-client-${choice.id}`}
            className={cn(
              "flex items-center justify-between rounded-md border px-4 py-3 text-left transition-colors",
              value === choice.id
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/40",
            )}
          >
            <div>
              <div className="text-sm font-medium">{choice.label}</div>
              <div className="text-xs text-muted-foreground">{choice.sub}</div>
            </div>
            {value === choice.id && <Check className="h-4 w-4 text-primary" />}
          </button>
        ))}
      </div>
    </div>
  );
}

function NameAndTtlStep({
  name,
  onNameChange,
  ttlId,
  onTtlChange,
}: {
  name: string;
  onNameChange: (v: string) => void;
  ttlId: string;
  onTtlChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="share-link-name">Label (optional)</Label>
        <Input
          id="share-link-name"
          placeholder="e.g. Onboarding share for Alex"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          maxLength={200}
        />
        <p className="text-xs text-muted-foreground">
          Helps you tell links apart on the share-links list.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Expiration</Label>
        <div className="grid grid-cols-3 gap-2">
          {SHARE_TTL_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              onClick={() => onTtlChange(preset.id)}
              data-testid={`share-ttl-${preset.id}`}
              className={cn(
                "rounded-md border px-3 py-2 text-sm transition-colors",
                ttlId === preset.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted/40",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function InstallSnippetsStep({
  clients,
  cloneUrl,
  marketplaceName,
  skillSlug,
}: {
  clients: ShareClient[];
  cloneUrl: string;
  marketplaceName: string;
  skillSlug: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900/60 dark:bg-amber-950/40">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-amber-900 dark:text-amber-100">
          The install URL contains a token that lets anyone with the URL clone
          this skill. Once installed, the URL is stored in the user's local git
          config. Revoke the link when sharing ends.
        </p>
      </div>

      {clients.map((client) => {
        const steps = client.getInstallSteps({
          cloneUrl,
          marketplaceName,
          skillSlug,
        });
        return (
          <section
            key={client.id}
            data-testid={`share-snippets-${client.id}`}
            className="flex flex-col gap-3"
          >
            <header>
              <div className="text-sm font-semibold">{client.label}</div>
              <div className="text-xs text-muted-foreground">{client.sub}</div>
            </header>
            <ol className="flex flex-col gap-3">
              {steps.map((step, idx) => (
                <SnippetStep
                  key={`${client.id}-${step.label}`}
                  index={idx + 1}
                  step={step}
                />
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function SnippetStep({
  index,
  step,
}: {
  index: number;
  step: ShareInstallStep;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-mono text-xs text-muted-foreground">
          {index}.
        </span>
        <span className="font-medium">{step.label}</span>
      </div>
      {step.body && (
        <p className="text-xs text-muted-foreground">{step.body}</p>
      )}
      {step.code && (
        <div className="flex items-center justify-between gap-2 rounded border bg-background px-3 py-2 font-mono text-xs">
          <code className="overflow-x-auto whitespace-pre">{step.code}</code>
          <CopyButton text={step.code} />
        </div>
      )}
    </li>
  );
}

function ShareFlowFooter({
  step,
  onBack,
  onNext,
  onCreate,
  onClose,
  isCreating,
  isRevoking,
  canRevoke,
  confirmRevoke,
  onRequestRevoke,
  onCancelRevoke,
  onConfirmRevoke,
}: {
  step: 1 | 2 | 3;
  onBack: () => void;
  onNext: () => void;
  onCreate: () => void;
  onClose: () => void;
  isCreating: boolean;
  isRevoking: boolean;
  canRevoke: boolean;
  confirmRevoke: boolean;
  onRequestRevoke: () => void;
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
}) {
  if (step === 3) {
    if (confirmRevoke) {
      return (
        <DialogStickyFooter className="mt-0">
          <div className="mr-auto text-xs text-muted-foreground">
            Revoking deletes the marketplace; existing clones can no longer
            pull.
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={onCancelRevoke}
            disabled={isRevoking}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirmRevoke}
            disabled={isRevoking}
          >
            {isRevoking ? "Revoking…" : "Confirm revoke"}
          </Button>
        </DialogStickyFooter>
      );
    }
    return (
      <DialogStickyFooter className="mt-0">
        {canRevoke && (
          <Button
            type="button"
            variant="ghost"
            onClick={onRequestRevoke}
            className="mr-auto text-destructive hover:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Revoke share link
          </Button>
        )}
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </DialogStickyFooter>
    );
  }

  return (
    <DialogStickyFooter className="mt-0">
      <Button type="button" variant="outline" onClick={onClose}>
        Cancel
      </Button>
      {step === 2 && (
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
      )}
      {step === 1 ? (
        <Button type="button" onClick={onNext}>
          Continue
        </Button>
      ) : (
        <Button type="button" onClick={onCreate} disabled={isCreating}>
          {isCreating ? "Creating…" : "Create share link"}
        </Button>
      )}
    </DialogStickyFooter>
  );
}
