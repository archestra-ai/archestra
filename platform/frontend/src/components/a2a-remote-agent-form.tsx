"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { A2aRemoteAgentScopeSelector } from "@/components/a2a-remote-agent-scope-selector";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { FloatingActionBar } from "@/components/settings/settings-block";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SecretInput } from "@/components/ui/secret-input";
import { Textarea } from "@/components/ui/textarea";
import type {
  A2aRemoteAgent,
  UpdateA2aRemoteAgentBody,
} from "@/lib/a2a-remote-agents.query";
import { useInspectA2aRemoteAgent } from "@/lib/a2a-remote-agents.query";
import { useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { getApiErrorMessage } from "@/lib/utils";

type AuthType = "none" | "bearer" | "api_key";
type AccessChoice = ResourceVisibilityScope | "user";
type Source = NonNullable<UpdateA2aRemoteAgentBody["source"]>;
type Auth = NonNullable<UpdateA2aRemoteAgentBody["auth"]>;
type Inspection = archestraApiTypes.InspectA2aRemoteAgentResponses["200"];
type FormValues = {
  url: string;
  name: string;
  description: string;
  authType: AuthType;
  headerName: string;
  credential: string;
  scope: ResourceVisibilityScope;
  accessChoice: AccessChoice;
  teamIds: string[];
  userIds: string[];
};

export type A2aRemoteAgentFormSubmission = UpdateA2aRemoteAgentBody;

const AUTH_LABELS: Record<AuthType, string> = {
  none: "None",
  bearer: "Bearer token",
  api_key: "API key header",
};
const ALL_AUTH_TYPES: AuthType[] = ["none", "bearer", "api_key"];

export function A2aRemoteAgentForm({
  agent,
  readOnly = false,
  isSaving,
  onSubmit,
  onDirtyChange,
}: {
  agent?: A2aRemoteAgent;
  readOnly?: boolean;
  isSaving: boolean;
  onSubmit: (submission: A2aRemoteAgentFormSubmission) => void;
  onDirtyChange?: (isDirty: boolean) => void;
}) {
  const formId = useId();
  const initial = valuesFromAgent(agent);
  const form = useForm<FormValues>({ defaultValues: initial });
  const { mutate: inspectRemoteAgent, reset: resetRemoteAgentInspection } =
    useInspectA2aRemoteAgent();
  const appName = useAppName();
  const { data: session } = useSession();
  const [inspection, setInspection] = useState<Inspection | null>(() =>
    agent ? inspectionFromAgent(agent) : null,
  );
  const [capabilitiesInspected, setCapabilitiesInspected] = useState(false);
  const [compatibleStamp, setCompatibleStamp] = useState<string | null>(() =>
    agent ? connectionStamp(initial, agent) : null,
  );
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [inspectionPending, setInspectionPending] = useState(false);
  const requestRef = useRef(0);
  const refreshedAgentIdRef = useRef<string | null>(null);
  const values = form.watch();
  const keepsLegacySource = !!agent && !storedWellKnownBaseUrl(agent);
  const urlRequiredMessage = keepsLegacySource
    ? undefined
    : "An agent base URL is required.";
  const connectionNeedsInspection =
    connectionStamp(values, agent) !== compatibleStamp;
  const inspectionNeedsPersistence =
    !!agent && !!inspection && inspection.cardHash !== agent.cardHash;
  const isDirty = form.formState.isDirty || inspectionNeedsPersistence;

  useEffect(() => onDirtyChange?.(isDirty), [isDirty, onDirtyChange]);
  useEffect(
    () => () => {
      requestRef.current += 1;
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  const invalidateSource = () => {
    requestRef.current += 1;
    form.clearErrors("url");
    resetRemoteAgentInspection();
    setInspection(null);
    setCapabilitiesInspected(false);
    setCompatibleStamp(null);
    setInspectionError(null);
    setInspectionPending(false);
  };
  const invalidateCompatibility = () => {
    requestRef.current += 1;
    resetRemoteAgentInspection();
    setCompatibleStamp(null);
    setInspectionError(null);
    setInspectionPending(false);
  };

  const inspectCompatibility = useCallback(
    ({
      knownInspection,
      nextAuthType = form.getValues("authType"),
      nextHeaderName = form.getValues("headerName"),
    }: {
      knownInspection: Inspection;
      nextAuthType?: AuthType;
      nextHeaderName?: string;
    }) => {
      const draft = {
        ...form.getValues(),
        authType: nextAuthType,
        headerName: nextHeaderName,
      };
      const source = sourceForInspection(draft, agent);
      if (!source) return;
      if (nextAuthType === "api_key" && !nextHeaderName.trim()) {
        form.setError("headerName", { message: "A header name is required." });
        return;
      }
      form.clearErrors("headerName");
      const requestId = ++requestRef.current;
      setInspectionPending(true);
      setInspectionError(null);
      inspectRemoteAgent(
        {
          source,
          auth:
            nextAuthType === "api_key"
              ? { type: "api_key", headerName: nextHeaderName.trim() }
              : { type: nextAuthType },
        },
        {
          onSuccess: (result) => {
            if (requestId !== requestRef.current) return;
            if (!result) {
              setInspectionError("The Agent Card inspection returned no data.");
              setInspectionPending(false);
              return;
            }
            setInspection(result);
            setCapabilitiesInspected(true);
            setCompatibleStamp(connectionStamp(draft, agent));
            setInspectionPending(false);
          },
          onError: (error) => {
            if (requestId !== requestRef.current) return;
            setInspection(knownInspection);
            setCompatibleStamp(null);
            setInspectionError(getApiErrorMessage(error));
            setInspectionPending(false);
          },
        },
      );
    },
    [agent, form, inspectRemoteAgent],
  );

  useEffect(() => {
    if (
      readOnly ||
      !agent ||
      !storedWellKnownBaseUrl(agent) ||
      refreshedAgentIdRef.current === agent.id
    )
      return;
    refreshedAgentIdRef.current = agent.id;
    inspectCompatibility({ knownInspection: inspectionFromAgent(agent) });
    return () => {
      if (refreshedAgentIdRef.current === agent.id) {
        refreshedAgentIdRef.current = null;
      }
    };
  }, [agent, inspectCompatibility, readOnly]);

  const inspectSource = async () => {
    if (!(await form.trigger("url"))) return;
    const draft = form.getValues();
    const source = sourceForInspection(draft, agent);
    if (!source) return;
    const requestId = ++requestRef.current;
    setInspectionPending(true);
    setInspectionError(null);
    setInspection(null);
    setCompatibleStamp(null);
    inspectRemoteAgent(
      { source },
      {
        onSuccess: (result) => {
          if (requestId !== requestRef.current) return;
          if (!result) {
            setInspectionError("The Agent Card inspection returned no data.");
            setInspectionPending(false);
            return;
          }
          setInspection(result);
          setCapabilitiesInspected(true);
          const nextAuthType = result.supportedAuthTypes.includes(
            draft.authType,
          )
            ? draft.authType
            : result.supportedAuthTypes[0];
          if (!nextAuthType) {
            setInspectionError(
              "This Agent Card does not advertise a supported authentication method.",
            );
            setInspectionPending(false);
            return;
          }
          if (nextAuthType !== draft.authType)
            form.setValue("authType", nextAuthType, { shouldDirty: true });
          inspectCompatibility({ knownInspection: result, nextAuthType });
        },
        onError: (error) => {
          if (requestId !== requestRef.current) return;
          setCapabilitiesInspected(false);
          setInspectionError(getApiErrorMessage(error));
          setInspectionPending(false);
        },
      },
    );
  };

  const validateCredential = () => {
    form.clearErrors("credential");
    if (values.authType === "none") return true;
    if (values.credential.trim() || keepsStoredCredential(values, agent))
      return true;
    form.setError("credential", {
      message: agent
        ? "Enter a credential when changing authentication."
        : "A credential is required.",
    });
    return false;
  };
  const validateAccess = () => {
    form.clearErrors(["teamIds", "userIds"]);
    const current = form.getValues();
    if (current.accessChoice === "team" && current.teamIds.length === 0) {
      form.setError("teamIds", { message: "Select at least one team." });
      return false;
    }
    if (current.accessChoice === "user" && current.userIds.length === 0) {
      form.setError("userIds", { message: "Select at least one user." });
      return false;
    }
    return true;
  };

  const buildSubmission = (): A2aRemoteAgentFormSubmission | null => {
    const current = form.getValues();
    if (connectionStamp(current, agent) !== compatibleStamp) return null;
    const source = parseSource({ values: current, agent, form });
    const auth = parseAuth({ values: current, agent, form });
    if (source === null || auth === null || !validateAccess()) return null;
    const scope = current.accessChoice === "user" ? "personal" : current.scope;
    const teams = current.accessChoice === "team" ? current.teamIds : [];
    const users = current.accessChoice === "user" ? current.userIds : [];
    if (!agent) {
      if (!source) return null;
      return {
        source,
        ...(auth ? { auth } : {}),
        name: current.name.trim() || undefined,
        description: current.description.trim() || undefined,
        scope,
        teams,
        users,
      };
    }
    const submission: A2aRemoteAgentFormSubmission = {};
    if (
      source &&
      (!sameSource(source, agent) ||
        (inspectionNeedsPersistence && agent.discoveryMode === "well_known"))
    )
      submission.source = source;
    if (auth) submission.auth = auth;
    const name = current.name.trim();
    if (name && name !== agent.name) submission.name = name;
    const description = current.description.trim() || null;
    if (description !== agent.description) submission.description = description;
    if (
      scope !== agent.scope ||
      !sameIds(
        teams,
        agent.teams.map((team) => team.id),
      ) ||
      !sameIds(
        users,
        agent.users.map((user) => user.id),
      )
    ) {
      submission.scope = scope;
      submission.teams = teams;
      submission.users = users;
    }
    return submission;
  };

  const discardChanges = () => {
    const resetValues = valuesFromAgent(agent);
    requestRef.current += 1;
    form.reset(resetValues);
    setInspection(agent ? inspectionFromAgent(agent) : null);
    setCapabilitiesInspected(false);
    setCompatibleStamp(agent ? connectionStamp(resetValues, agent) : null);
    setInspectionError(null);
    setInspectionPending(false);
    resetRemoteAgentInspection();
  };
  const submit = form.handleSubmit(() => {
    if (!validateCredential()) return;
    const submission = buildSubmission();
    if (!submission) return;
    if (agent && Object.keys(submission).length === 0) {
      discardChanges();
      return;
    }
    onSubmit(submission);
  });
  const hasRequiredCredential =
    values.authType === "none" ||
    !!values.credential.trim() ||
    keepsStoredCredential(values, agent);
  const hasValidAccessSelection =
    (values.accessChoice !== "user" || values.userIds.length > 0) &&
    (values.accessChoice !== "team" || values.teamIds.length > 0);
  const canSubmit =
    !inspectionPending &&
    !connectionNeedsInspection &&
    !!inspection &&
    hasRequiredCredential &&
    hasValidAccessSelection &&
    (!agent || isDirty);

  if (readOnly && agent) {
    return <ReadOnlySummary agent={agent} currentUserId={session?.user?.id} />;
  }

  return (
    <>
      <form id={formId} className="flex flex-col" onSubmit={submit}>
        <SettingsSectionGroup>
          <SettingsSection
            title="Connection"
            description="Discover the Agent Card from the external agent's base URL."
          >
            <div className="space-y-2">
              <Label htmlFor="a2a-url">Agent base URL</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="a2a-url"
                  type="url"
                  aria-invalid={!!form.formState.errors.url}
                  aria-describedby="a2a-url-help a2a-url-error"
                  placeholder="https://agent.example.com"
                  {...form.register("url", {
                    required: urlRequiredMessage,
                    validate: (value) =>
                      keepsLegacySource && !value.trim()
                        ? true
                        : !!normalizeAgentBaseUrl(value.trim()) ||
                          "Enter an HTTP(S) base URL without credentials, a query, or a fragment.",
                    onChange: invalidateSource,
                  })}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  disabled={inspectionPending || !values.url.trim()}
                  onClick={() => void inspectSource()}
                >
                  <span>
                    {inspectionPending ? "Checking…" : "Check Agent Card"}
                  </span>
                </Button>
              </div>
              <FieldDescription id="a2a-url-help">
                {keepsLegacySource
                  ? "This connection uses a legacy Agent Card source. Leave this blank to keep it, or enter a base URL to replace it."
                  : "We'll append /.well-known/agent-card.json to this base URL."}
              </FieldDescription>
              {form.formState.errors.url ? (
                <p
                  id="a2a-url-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {form.formState.errors.url.message}
                </p>
              ) : null}
              {inspectionPending ? (
                <output
                  aria-label="Checking Agent Card"
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>
                    Checking the Agent Card and authentication settings…
                  </span>
                </output>
              ) : null}
              {inspectionError ? (
                <p
                  role="alert"
                  aria-label="Agent Card unavailable"
                  className="text-sm text-destructive"
                >
                  {inspectionError}
                </p>
              ) : null}
              {inspection && !inspectionError ? (
                <output
                  aria-label="Agent Card found"
                  className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm"
                >
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" />
                  <div>
                    <p className="font-medium">{inspection.name}</p>
                    <p className="text-muted-foreground">
                      {inspection.selectedInterface.protocolBinding},{" "}
                      {inspection.selectedInterface.protocolVersion}
                    </p>
                  </div>
                </output>
              ) : null}
            </div>
          </SettingsSection>
          <SettingsSection
            title="Authentication"
            description={`Configure how ${appName} authenticates requests to this external agent.`}
          >
            {!agent && !inspection ? (
              <p className="text-sm text-muted-foreground">
                Check the Agent Card to see its supported authentication
                methods.
              </p>
            ) : null}
            <RadioGroup
              aria-label="Authentication"
              value={values.authType}
              onValueChange={(value) => {
                const nextAuthType = value as AuthType;
                form.setValue("authType", nextAuthType, {
                  shouldDirty: true,
                });
                invalidateCompatibility();
                if (inspection)
                  inspectCompatibility({
                    knownInspection: inspection,
                    nextAuthType,
                  });
              }}
              className="grid gap-2 sm:grid-cols-3"
            >
              {ALL_AUTH_TYPES.map((authType) => {
                const unsupported =
                  capabilitiesInspected &&
                  !!inspection &&
                  !inspection.supportedAuthTypes.includes(authType);
                return (
                  <Label
                    key={authType}
                    htmlFor={`a2a-auth-${authType}`}
                    className="flex cursor-pointer items-start gap-2 rounded-md border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50"
                  >
                    <RadioGroupItem
                      id={`a2a-auth-${authType}`}
                      value={authType}
                      disabled={unsupported}
                    />
                    <span className="space-y-1">
                      <span className="block">{AUTH_LABELS[authType]}</span>
                      {unsupported ? (
                        <span className="block text-xs font-normal text-muted-foreground">
                          Not supported by this Agent Card
                        </span>
                      ) : null}
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
            {values.authType === "api_key" ? (
              <div className="space-y-2">
                <Label htmlFor="a2a-header">Header name</Label>
                <Input
                  id="a2a-header"
                  aria-invalid={!!form.formState.errors.headerName}
                  aria-describedby="a2a-header-error"
                  {...form.register("headerName", {
                    required: "A header name is required.",
                    onChange: invalidateCompatibility,
                    onBlur: () => {
                      if (inspection && form.getValues("headerName").trim())
                        inspectCompatibility({
                          knownInspection: inspection,
                        });
                    },
                  })}
                />
                {form.formState.errors.headerName ? (
                  <p
                    id="a2a-header-error"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {form.formState.errors.headerName.message}
                  </p>
                ) : null}
              </div>
            ) : null}
            {values.authType !== "none" ? (
              <div className="space-y-2">
                <Label htmlFor="a2a-credential">
                  {agent?.connection.hasCredential
                    ? "Replace credential (optional)"
                    : "Credential"}
                </Label>
                <SecretInput
                  id="a2a-credential"
                  revealable
                  aria-invalid={!!form.formState.errors.credential}
                  aria-describedby="a2a-credential-help a2a-credential-error"
                  placeholder={
                    agent?.connection.hasCredential ? "••••••••" : undefined
                  }
                  {...form.register("credential")}
                />
                <FieldDescription id="a2a-credential-help">
                  {agent?.connection.hasCredential
                    ? "Leave this blank to keep the stored credential, or enter a replacement."
                    : "The credential is stored securely and cannot be shown again."}
                </FieldDescription>
                {form.formState.errors.credential ? (
                  <p
                    id="a2a-credential-error"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {form.formState.errors.credential.message}
                  </p>
                ) : null}
              </div>
            ) : null}
            {inspection && !inspectionPending && !connectionNeedsInspection ? (
              <output
                aria-label="Connection compatible"
                className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>
                  Agent Card and authentication settings are compatible.
                </span>
              </output>
            ) : null}
          </SettingsSection>
          <SettingsSection
            title="Details"
            description={
              agent
                ? `Customize how this external agent appears in ${appName}.`
                : "Optional local details. Empty fields use the Agent Card values."
            }
          >
            <div className="space-y-2">
              <Label htmlFor="a2a-name">Display name (optional)</Label>
              <Input
                id="a2a-name"
                placeholder={inspection?.name ?? "Uses the Agent Card name"}
                {...form.register("name")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="a2a-description">Description (optional)</Label>
              <Textarea
                id="a2a-description"
                rows={3}
                placeholder={
                  inspection?.description ?? "Uses the Agent Card description"
                }
                {...form.register("description")}
              />
            </div>
          </SettingsSection>
          <SettingsSection
            title="Access"
            description="Choose who can discover and assign this external agent."
          >
            <div
              aria-invalid={
                !!form.formState.errors.teamIds ||
                !!form.formState.errors.userIds
              }
              aria-describedby="a2a-access-error"
            >
              <A2aRemoteAgentScopeSelector
                initialScope={agent?.scope}
                onChoiceChange={(choice) => {
                  form.clearErrors(["teamIds", "userIds"]);
                  form.setValue("accessChoice", choice, {
                    shouldDirty: true,
                  });
                }}
                scope={values.scope}
                onScopeChange={(scope) =>
                  form.setValue("scope", scope, { shouldDirty: true })
                }
                teamIds={values.teamIds}
                onTeamIdsChange={(ids) =>
                  form.setValue("teamIds", ids, { shouldDirty: true })
                }
                userIds={values.userIds}
                onUserIdsChange={(ids) =>
                  form.setValue("userIds", ids, { shouldDirty: true })
                }
              />
            </div>
            {form.formState.errors.teamIds ? (
              <p
                id="a2a-access-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {form.formState.errors.teamIds.message}
              </p>
            ) : null}
            {form.formState.errors.userIds ? (
              <p
                id="a2a-access-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {form.formState.errors.userIds.message}
              </p>
            ) : null}
          </SettingsSection>
        </SettingsSectionGroup>
      </form>
      <FloatingActionBar>
        <Button type="submit" form={formId} disabled={isSaving || !canSubmit}>
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          <span>
            {isSaving
              ? agent
                ? "Saving..."
                : "Connecting..."
              : agent
                ? "Save changes"
                : "Connect agent"}
          </span>
        </Button>
      </FloatingActionBar>
    </>
  );
}

function ReadOnlySummary({
  agent,
  currentUserId,
}: {
  agent: A2aRemoteAgent;
  currentUserId?: string;
}) {
  return (
    <div className="space-y-6">
      <Alert>
        <AlertDescription>
          You can view this external agent, but you do not have permission to
          change its connection or access settings.
        </AlertDescription>
      </Alert>
      <SettingsSectionGroup>
        <SettingsSection title="Connection">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <SummaryItem
              label="Delegation"
              value={agent.connection.enabled ? "Enabled" : "Paused"}
            />
            <SummaryItem
              label="Discovery URL"
              value={
                storedWellKnownBaseUrl(agent) ?? "Legacy Agent Card source"
              }
            />
            <SummaryItem
              label="Protocol"
              value={`${agent.connection.selectedInterface.protocolBinding} ${agent.connection.selectedInterface.protocolVersion}`}
            />
            <SummaryItem
              label="Last discovered"
              value={new Date(agent.lastDiscoveredAt).toLocaleString()}
            />
          </dl>
        </SettingsSection>
        <SettingsSection title="Authentication">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <SummaryItem
              label="Method"
              value={AUTH_LABELS[agent.connection.authType]}
            />
            <SummaryItem
              label="Credential"
              value={
                agent.connection.hasCredential ? "Configured" : "Not configured"
              }
            />
          </dl>
        </SettingsSection>
        <SettingsSection title="Details">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <SummaryItem label="Display name" value={agent.name} />
            <SummaryItem
              label="Description"
              value={agent.description || "No description"}
            />
          </dl>
        </SettingsSection>
        <SettingsSection title="Access">
          <ResourceVisibilityBadge
            scope={agent.scope}
            teams={agent.teams}
            users={agent.users}
            authorId={agent.authorId}
            authorName={agent.authorName}
            currentUserId={currentUserId}
            showSelfAsMe
          />
        </SettingsSection>
      </SettingsSectionGroup>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words font-medium">{value}</dd>
    </div>
  );
}

function valuesFromAgent(agent?: A2aRemoteAgent): FormValues {
  const scope = agent?.scope ?? "personal";
  const userIds = agent?.users.map((user) => user.id) ?? [];
  return {
    url: storedWellKnownBaseUrl(agent) ?? "",
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    authType: agent?.connection.authType ?? "none",
    headerName: agent?.connection.authConfig.headerName ?? "X-API-Key",
    credential: "",
    scope,
    accessChoice: scope === "personal" && userIds.length > 0 ? "user" : scope,
    teamIds: agent?.teams.map((team) => team.id) ?? [],
    userIds,
  };
}
function inspectionFromAgent(agent: A2aRemoteAgent): Inspection {
  return {
    name: agent.name,
    description: agent.description,
    agentCard: agent.agentCard,
    cardHash: agent.cardHash,
    selectedInterface: agent.connection.selectedInterface,
    supportedAuthTypes: ALL_AUTH_TYPES,
    selectedSecurityRequirement: agent.connection.securityRequirement,
  };
}
function sourceForInspection(
  values: FormValues,
  agent?: A2aRemoteAgent,
): Source | null {
  const url = normalizeAgentBaseUrl(values.url.trim());
  if (url) return { type: "well_known", url };
  if (agent && !storedWellKnownBaseUrl(agent) && !values.url.trim())
    return { type: "inline_card", agentCard: agent.agentCard };
  return null;
}
function connectionStamp(values: FormValues, agent?: A2aRemoteAgent) {
  const source = sourceForInspection(values, agent);
  if (!source) return null;
  const sourceKey =
    source.type === "well_known"
      ? source.url
      : `inline:${agent?.cardHash ?? ""}`;
  const header =
    values.authType === "api_key" ? values.headerName.trim().toLowerCase() : "";
  return `${sourceKey}|${values.authType}|${header}`;
}
function parseSource({
  values,
  agent,
  form,
}: {
  values: FormValues;
  agent?: A2aRemoteAgent;
  form: ReturnType<typeof useForm<FormValues>>;
}): Source | undefined | null {
  form.clearErrors("url");
  const enteredUrl = values.url.trim();
  if (agent && !storedWellKnownBaseUrl(agent) && !enteredUrl) return undefined;
  const url = normalizeAgentBaseUrl(enteredUrl);
  if (!url) {
    form.setError("url", {
      message:
        "Enter an HTTP(S) base URL without credentials, a query, or a fragment.",
    });
    return null;
  }
  return { type: "well_known", url };
}
function parseAuth({
  values,
  agent,
  form,
}: {
  values: FormValues;
  agent?: A2aRemoteAgent;
  form: ReturnType<typeof useForm<FormValues>>;
}): Auth | undefined | null {
  form.clearErrors(["credential", "headerName"]);
  if (values.authType === "none")
    return agent?.connection.authType === "none" ? undefined : { type: "none" };
  const credential = values.credential.trim();
  const keepsStored = keepsStoredCredential(values, agent);
  if (!credential && keepsStored) return undefined;
  if (!credential) {
    form.setError("credential", {
      message: agent
        ? "Enter a credential when changing authentication."
        : "A credential is required.",
    });
    return null;
  }
  if (values.authType === "bearer") return { type: "bearer", credential };
  const headerName = values.headerName.trim();
  if (!headerName) {
    form.setError("headerName", { message: "A header name is required." });
    return null;
  }
  return { type: "api_key", headerName, credential };
}
function sameSource(source: Source, agent: A2aRemoteAgent) {
  return (
    source.type === "well_known" &&
    agent.discoveryMode === "well_known" &&
    source.url === normalizeAgentBaseUrl(agent.discoveryUrl ?? "")
  );
}
function keepsStoredCredential(values: FormValues, agent?: A2aRemoteAgent) {
  return (
    !!agent?.connection.hasCredential &&
    values.authType === agent.connection.authType &&
    (values.authType !== "api_key" ||
      values.headerName.trim().toLowerCase() ===
        (agent.connection.authConfig.headerName ?? "X-API-Key").toLowerCase())
  );
}
function storedWellKnownBaseUrl(agent?: A2aRemoteAgent) {
  if (agent?.discoveryMode !== "well_known" || !agent.discoveryUrl) return null;
  return normalizeAgentBaseUrl(agent.discoveryUrl);
}
function normalizeAgentBaseUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    return pathname ? `${url.origin}${pathname}` : url.origin;
  } catch {
    return null;
  }
}
function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const ids = new Set(right);
  return left.every((id) => ids.has(id));
}
