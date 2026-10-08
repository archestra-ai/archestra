"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BudgetFields,
  describeWindow,
  type SpendCapValue,
} from "@/components/credential-billing/budget-fields";
import { ExpirySelect } from "@/components/credential-billing/expiry-select";
import { ProviderKeyPicker } from "@/components/credential-billing/provider-key-picker";
import {
  ReviewList,
  ReviewListRow,
} from "@/components/credential-billing/review-list";
import { WizardSteps } from "@/components/credential-billing/wizard-steps";
import { FormDialog } from "@/components/form-dialog";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";
import { useConnectionBaseUrl } from "@/components/virtual-key-connection-base-url";
import { VirtualKeyConnectionGuide } from "@/components/virtual-key-connection-guide";
import { useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useTeams } from "@/lib/teams/team.query";
import { formatRelativeTime } from "@/lib/utils/date-time";
import {
  useAllVirtualApiKeys,
  useCreateVirtualApiKey,
} from "@/lib/virtual-api-keys.query";

export type VirtualKeyType = NonNullable<
  archestraApiTypes.CreateVirtualApiKeyData["body"]["keyType"]
>;
type VirtualKeySummary =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];
export type CreatedVirtualKey =
  archestraApiTypes.CreateVirtualApiKeyResponses["200"];

/**
 * Self-contained variant for resource connection surfaces: gathers the option
 * data the form needs.
 */
export function CreateVirtualKeyDialogWithData({
  open,
  onOpenChange,
  keyType,
  initialProviderApiKeys,
  onCreated,
  targetLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyType: VirtualKeyType;
  /** What the key is for, named in the title (e.g. "Model Router"). */
  targetLabel?: string;
  /** Provider keys the new key starts mapped to (standard keys only). */
  initialProviderApiKeys?: ProviderApiKeyMappings;
  /**
   * Hands the created key to the caller, which shows its value itself; the
   * dialog then closes instead of switching to its own reveal view.
   */
  onCreated?: (key: CreatedVirtualKey) => void;
}) {
  const { data: apiKeys = [] } = useLlmProviderApiKeys({ enabled: open });
  const { data: session } = useSession();
  const connectionBaseUrl = useConnectionBaseUrl();
  const { data: existingKeys } = useAllVirtualApiKeys({
    keyType,
    limit: 100,
    offset: 0,
    enabled: open && keyType === "standard",
    toastOnError: false,
  });
  const defaultExpirationSeconds = useFeature(
    "virtualKeyDefaultExpirationSeconds",
  );

  return (
    <CreateVirtualKeyDialog
      open={open}
      onOpenChange={onOpenChange}
      keyType={keyType}
      parentableKeys={apiKeys}
      connectionBaseUrl={connectionBaseUrl}
      defaultExpirationSeconds={defaultExpirationSeconds ?? null}
      currentUser={
        session?.user
          ? {
              id: session.user.id,
              name: session.user.name ?? session.user.email ?? null,
            }
          : null
      }
      existingKeys={existingKeys?.data ?? []}
      initialProviderApiKeys={initialProviderApiKeys}
      onCreated={onCreated}
      targetLabel={targetLabel}
    />
  );
}

export function CreateVirtualKeyDialog({
  open,
  onOpenChange,
  keyType,
  parentableKeys,
  connectionBaseUrl,
  defaultExpirationSeconds,
  currentUser,
  existingKeys,
  initialProviderApiKeys,
  onCreated,
  targetLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyType: VirtualKeyType;
  parentableKeys: LlmProviderApiKeyResponse[];
  connectionBaseUrl: string;
  defaultExpirationSeconds: number | null;
  currentUser: { id: string; name: string | null } | null;
  existingKeys: VirtualKeySummary[];
  initialProviderApiKeys?: ProviderApiKeyMappings;
  onCreated?: (key: CreatedVirtualKey) => void;
  targetLabel?: string;
}) {
  const createMutation = useCreateVirtualApiKey();

  const [newKeyName, setNewKeyName] = useState("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [step, setStep] = useState<CreateStep>("key");
  const [billingTeamId, setBillingTeamId] = useState<string | null>(null);
  const [spendCap, setSpendCap] = useState<SpendCapValue>(null);
  const [providerApiKeyIds, setProviderApiKeyIds] =
    useState<ProviderApiKeyMappings>([]);
  const [createdKey, setCreatedKey] = useState<CreatedVirtualKey | null>(null);
  const createdKeyValue = createdKey?.value ?? null;

  // False so a dialog mounted already open is seeded too.
  const prevOpenRef = useRef(false);
  // Read when the dialog opens, not tracked: the form is seeded once per
  // opening, and a re-render with a new array must not wipe the user's edits.
  const initialProviderApiKeysRef = useRef(initialProviderApiKeys);
  initialProviderApiKeysRef.current = initialProviderApiKeys;
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);
  const generatedNameRef = useRef("");

  const isPassthrough = keyType === "passthrough";
  // A new key belongs to its creator. Who else may use it is set by its
  // permissions, and who pays for it by its billing team.
  const generatedName = useMemo(
    () =>
      isPassthrough
        ? ""
        : getGeneratedVirtualKeyName({
            ownerId: currentUser?.id,
            ownerName: currentUser?.name,
            existingKeys,
          }),
    [currentUser?.id, currentUser?.name, existingKeys, isPassthrough],
  );

  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      setCreatedKey(null);
      const initialExpiresAt = computeDefaultExpiresAt(
        defaultExpirationSeconds,
      );
      setNewKeyName(generatedName);
      generatedNameRef.current = generatedName;
      setExpiresAt(initialExpiresAt);

      const initialMappings =
        keyType === "passthrough"
          ? []
          : (initialProviderApiKeysRef.current ?? []);
      setProviderApiKeyIds(initialMappings);
      setStep("key");
      setBillingTeamId(null);
      setSpendCap(null);
      initialSnapshotRef.current = {
        keyType,
        newKeyName: generatedName,
        expiresAt: initialExpiresAt,
        providerApiKeyIds: initialMappings,
        billingTeamId: null,
        spendCap: null,
      };
    }
  }, [open, defaultExpirationSeconds, keyType, generatedName]);

  useEffect(() => {
    if (!open || createdKeyValue) return;
    setNewKeyName((currentName) => {
      const shouldUpdate =
        currentName.length === 0 || currentName === generatedNameRef.current;
      generatedNameRef.current = generatedName;
      if (!shouldUpdate) return currentName;
      if (initialSnapshotRef.current) {
        initialSnapshotRef.current = {
          ...initialSnapshotRef.current,
          newKeyName: generatedName,
        };
      }
      return generatedName;
    });
  }, [createdKeyValue, generatedName, open]);
  const standardReady = providerApiKeyIds.length > 0;
  const keyStepReady =
    newKeyName.trim().length > 0 && (isPassthrough || standardReady);
  const canSubmit = keyStepReady && !createMutation.isPending;

  // Once the key is created the form is replaced by the reveal view, so there
  // is nothing left to lose — only guard the editable form.
  const isDirty =
    !createdKeyValue &&
    initialSnapshotRef.current !== null &&
    hasUnsavedChanges(initialSnapshotRef.current, {
      keyType,
      newKeyName,
      expiresAt,
      providerApiKeyIds,

      billingTeamId,
      spendCap,
    });

  const handleCreate = useCallback(async () => {
    if (!newKeyName.trim()) return;
    try {
      const result = await createMutation.mutateAsync({
        data: isPassthrough
          ? {
              name: newKeyName.trim(),
              keyType: "passthrough",
              expiresAt: expiresAt ?? undefined,
              labels: [],
              billingTeamId: billingTeamId ?? undefined,
              spendCap: spendCap ?? undefined,
            }
          : {
              name: newKeyName.trim(),
              keyType: "standard",
              expiresAt: expiresAt ?? undefined,
              providerApiKeys: providerApiKeyIds,
              labels: [],
              billingTeamId: billingTeamId ?? undefined,
              spendCap: spendCap ?? undefined,
            },
      });
      setNewKeyName("");
      if (result?.value) {
        if (onCreated) {
          onCreated(result);
          onOpenChange(false);
        } else {
          setCreatedKey(result);
        }
      }
    } catch {
      // handled by mutation
    }
  }, [
    createMutation,
    expiresAt,
    isPassthrough,

    providerApiKeyIds,
    newKeyName,
    onCreated,
    onOpenChange,
    billingTeamId,
    spendCap,
  ]);

  const steps = [
    { id: "key" as const, title: "Key" },
    { id: "budget" as const, title: "Budget" },
    { id: "review" as const, title: "Review" },
  ];
  const stepIndex = steps.findIndex((item) => item.id === step);
  const goNext = () => setStep(steps[stepIndex + 1]?.id ?? step);
  const goBack = () => setStep(steps[stepIndex - 1]?.id ?? step);

  // Who else can use the key is managed from its Permissions tab once it
  // exists, as for provider API keys.
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        createdKeyValue
          ? isPassthrough
            ? "Passthrough Virtual Key Created"
            : "Standard Virtual Key Created"
          : `New ${isPassthrough ? "passthrough key" : "virtual key"}${
              targetLabel ? ` for ${targetLabel}` : ""
            }`
      }
      description={
        createdKeyValue
          ? undefined
          : isPassthrough
            ? "It links requests that carry your own provider key to you."
            : "Pick the provider keys it uses, then who pays for it."
      }
      size={createdKeyValue ? "large" : "small"}
      className={createdKeyValue ? "max-w-4xl" : "sm:max-w-[680px]"}
      isDirty={isDirty}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (createdKeyValue) return;
          if (!isPassthrough && step !== "review") {
            if (keyStepReady) goNext();
            return;
          }
          if (canSubmit) void handleCreate();
        }}
        className="flex min-h-0 flex-col"
      >
        <DialogBody
          className="space-y-4"
          data-testid={E2eTestId.VirtualKeyCreateDialog}
        >
          {createdKey ? (
            <VirtualKeyConnectionGuide
              keyValue={createdKey.value}
              keyType={createdKey.keyType}
              mappedProviderKeys={createdKey.providerApiKeys}
              connectionBaseUrl={connectionBaseUrl}
              name={createdKey.name}
              expiration={formatExpiration(createdKey.expiresAt)}
              visibleTo={
                createdKey.keyType === "passthrough" ? null : "Only you"
              }
            />
          ) : (
            <>
              {!isPassthrough && (
                <WizardSteps
                  steps={steps}
                  activeStep={step}
                  onStepClick={setStep}
                  canVisitStep={(next) => next === "key" || keyStepReady}
                />
              )}
              {step === "key" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="virtual-key-name">Name</Label>
                    <Input
                      id="virtual-key-name"
                      autoFocus
                      value={newKeyName}
                      onChange={(event) => setNewKeyName(event.target.value)}
                      placeholder={
                        isPassthrough ? "My passthrough key" : "My virtual key"
                      }
                    />
                  </div>
                  {!isPassthrough && (
                    <div className="space-y-2">
                      <span className="font-medium text-sm">Provider keys</span>
                      <ProviderKeyPicker
                        value={providerApiKeyIds}
                        onChange={setProviderApiKeyIds}
                        providerApiKeys={parentableKeys}
                      />
                    </div>
                  )}
                </>
              )}
              {(isPassthrough || step === "budget") && (
                <>
                  <BudgetFields
                    subject="key"
                    idPrefix="virtual-key"
                    billingTeamId={billingTeamId}
                    onBillingTeamIdChange={setBillingTeamId}
                    spendCap={spendCap}
                    onSpendCapChange={setSpendCap}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="virtual-key-expires">Expires</Label>
                    <ExpirySelect
                      id="virtual-key-expires"
                      value={expiresAt}
                      onChange={setExpiresAt}
                    />
                  </div>
                </>
              )}
              {step === "review" && (
                <VirtualKeyReview
                  isPassthrough={isPassthrough}
                  name={newKeyName}
                  providerApiKeyIds={providerApiKeyIds}
                  providerApiKeys={parentableKeys}
                  billingTeamId={billingTeamId}
                  spendCap={spendCap}
                  expiresAt={expiresAt}
                  onEdit={setStep}
                />
              )}
            </>
          )}
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          {!createdKeyValue && !isPassthrough && stepIndex > 0 && (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={goBack}
            >
              Back
            </Button>
          )}
          <DialogCancelButton>
            {createdKeyValue ? "Close" : "Cancel"}
          </DialogCancelButton>
          {!createdKeyValue && !isPassthrough && step !== "review" && (
            <Button type="submit" disabled={!keyStepReady}>
              Continue
            </Button>
          )}
          {!createdKeyValue && (isPassthrough || step === "review") && (
            <Button type="submit" disabled={!canSubmit}>
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              <span>Create key</span>
            </Button>
          )}
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}

type CreateStep = "key" | "budget" | "review";

/** The last step: everything chosen so far, each with a way back to change it. */
function VirtualKeyReview({
  isPassthrough,
  name,
  providerApiKeyIds,
  providerApiKeys,
  billingTeamId,
  spendCap,
  expiresAt,
  onEdit,
}: {
  isPassthrough: boolean;
  name: string;
  providerApiKeyIds: ProviderApiKeyMappings;
  providerApiKeys: LlmProviderApiKeyResponse[];
  billingTeamId: string | null;
  spendCap: SpendCapValue;
  expiresAt: Date | null;
  onEdit: (step: CreateStep) => void;
}) {
  const catalog = useModelProviderCatalog();
  const { data: teams = [] } = useTeams({ enabled: !!billingTeamId });
  const teamName = teams.find((team) => team.id === billingTeamId)?.name;
  const keyName = (id: string) =>
    providerApiKeys.find((key) => key.id === id)?.name ?? "Unknown key";

  return (
    <div className="space-y-4">
      <ReviewList>
        <ReviewListRow label="Name" onEdit={() => onEdit("key")}>
          {name}
        </ReviewListRow>
        {!isPassthrough && (
          <ReviewListRow label="Provider keys" onEdit={() => onEdit("key")}>
            <span className="flex flex-wrap gap-1.5">
              {providerApiKeyIds.map((mapping) => (
                <span
                  key={mapping.provider}
                  className="rounded-full border bg-muted px-2 py-0.5 text-xs"
                >
                  {catalog.label(mapping.provider)} ·{" "}
                  {keyName(mapping.providerApiKeyId)}
                </span>
              ))}
            </span>
          </ReviewListRow>
        )}
        <ReviewListRow label="Billed to" onEdit={() => onEdit("budget")}>
          {billingTeamId ? (teamName ?? "A team") : "No team"}
        </ReviewListRow>
        <ReviewListRow label="Spend cap" onEdit={() => onEdit("budget")}>
          {spendCap
            ? `$${spendCap.limitValue.toLocaleString("en-US")} ${describeWindow(spendCap.cleanupInterval)}`
            : "No cap"}
        </ReviewListRow>
        <ReviewListRow label="Expires" onEdit={() => onEdit("budget")}>
          {expiresAt ? formatExpiration(expiresAt) : "Never"}
        </ReviewListRow>
      </ReviewList>
    </div>
  );
}

export function formatExpiration(date: Date | string | null): string {
  return formatRelativeTime(date);
}

function getGeneratedVirtualKeyName({
  ownerId,
  ownerName,
  existingKeys,
}: {
  ownerId: string | undefined;
  ownerName: string | null | undefined;
  existingKeys: VirtualKeySummary[];
}): string {
  const ownerLabel = ownerName?.trim();
  const baseName = ownerLabel
    ? `${ownerLabel.endsWith("s") ? `${ownerLabel}'` : `${ownerLabel}'s`} virtual key`
    : "My virtual key";
  const sequence =
    existingKeys.filter(
      (key) => key.authorId === ownerId && key.keyType === "standard",
    ).length + 1;
  return `${baseName} (${sequence})`;
}

function computeDefaultExpiresAt(defaultSeconds: number | null): Date | null {
  if (defaultSeconds === null) return null;
  return new Date(Date.now() + defaultSeconds * 1000);
}
