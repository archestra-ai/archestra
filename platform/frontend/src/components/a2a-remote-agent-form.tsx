"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { A2aRemoteAgentScopeSelector } from "@/components/a2a-remote-agent-scope-selector";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import {
  SettingsSection,
  SettingsSectionGroup,
} from "@/components/settings-section";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { WizardFooter } from "@/components/wizard-footer";
import type {
  A2aRemoteAgent,
  UpdateA2aRemoteAgentBody,
} from "@/lib/a2a-remote-agents.query";
import { useInspectA2aRemoteAgent } from "@/lib/a2a-remote-agents.query";
import { useSession } from "@/lib/auth/auth.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { getApiErrorMessage } from "@/lib/utils";

type AuthType = "none" | "bearer" | "api_key";
type Source = NonNullable<UpdateA2aRemoteAgentBody["source"]>;
type Auth = NonNullable<UpdateA2aRemoteAgentBody["auth"]>;

export type A2aRemoteAgentFormSubmission = UpdateA2aRemoteAgentBody;

type FormValues = {
  url: string;
  name: string;
  description: string;
  authType: AuthType;
  headerName: string;
  credential: string;
  scope: ResourceVisibilityScope;
  teamIds: string[];
  userIds: string[];
};

export function A2aRemoteAgentForm({
  agent,
  readOnly = false,
  isSaving,
  onSubmit,
  onCancel,
  onDirtyChange,
}: {
  agent?: A2aRemoteAgent;
  readOnly?: boolean;
  isSaving: boolean;
  onSubmit: (submission: A2aRemoteAgentFormSubmission) => void;
  onCancel: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
}) {
  const form = useForm<FormValues>({
    defaultValues: valuesFromAgent(agent),
  });
  const inspectMutation = useInspectA2aRemoteAgent();
  const [inspectionRequested, setInspectionRequested] = useState(false);
  const { data: session } = useSession();
  const url = form.watch("url");
  const authType = form.watch("authType");
  const debouncedUrl = useDebouncedValue(url, 400);
  const scope = form.watch("scope");
  const teamIds = form.watch("teamIds");
  const userIds = form.watch("userIds");
  const keepsLegacySource = !!agent && !storedWellKnownBaseUrl(agent);
  const inspectionNeedsPersistence =
    !!agent &&
    !!inspectMutation.data &&
    inspectMutation.data.cardHash !== agent.cardHash;

  useEffect(() => {
    onDirtyChange?.(form.formState.isDirty || inspectionNeedsPersistence);
  }, [form.formState.isDirty, inspectionNeedsPersistence, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  useEffect(() => {
    if (readOnly || !inspectionRequested) return;
    if (debouncedUrl !== url) return;
    const enteredUrl = debouncedUrl.trim();
    if (!enteredUrl) {
      form.clearErrors("url");
      return;
    }
    const normalizedUrl = normalizeAgentBaseUrl(enteredUrl);
    if (!normalizedUrl) {
      form.setError("url", {
        message: "Enter a base URL without a path, query, or fragment.",
      });
      return;
    }

    form.clearErrors("url");
    inspectMutation.mutate({
      source: { type: "well_known", url: normalizedUrl },
    });
  }, [
    debouncedUrl,
    form,
    inspectMutation.mutate,
    inspectionRequested,
    readOnly,
    url,
  ]);

  const requestInspection = () => {
    inspectMutation.reset();
    setInspectionRequested(true);
  };
  const updateControlled = (
    key: keyof FormValues,
    value: FormValues[keyof FormValues],
  ) => {
    form.setValue(key, value as never, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const buildSubmission = (): A2aRemoteAgentFormSubmission | null => {
    const values = form.getValues();
    const source = parseSource({ values, agent, form });
    if (source === null) return null;
    const auth = parseAuth({ values, agent, form });
    if (auth === null) return null;

    const teams = values.scope === "team" ? values.teamIds : [];
    const users = values.scope === "personal" ? values.userIds : [];
    form.clearErrors(["teamIds", "userIds"]);
    if (values.scope === "team" && teams.length === 0) {
      form.setError("teamIds", {
        message: "Select at least one team.",
      });
      return null;
    }
    if (!agent) {
      if (!source) return null;
      return {
        source,
        ...(auth ? { auth } : {}),
        name: values.name.trim() || undefined,
        description: values.description.trim() || undefined,
        scope: values.scope,
        teams,
        users,
      };
    }

    const submission: A2aRemoteAgentFormSubmission = {};
    if (source && (inspectionRequested || !sameSource(source, agent))) {
      submission.source = source;
    }
    if (auth) submission.auth = auth;
    const name = values.name.trim();
    if (name && name !== agent.name) submission.name = name;
    const description = values.description.trim() || null;
    if (description !== agent.description) submission.description = description;
    if (
      values.scope !== agent.scope ||
      !sameIds(
        teams,
        agent.teams.map((team) => team.id),
      ) ||
      !sameIds(
        users,
        agent.users.map((user) => user.id),
      )
    ) {
      submission.scope = values.scope;
      submission.teams = teams;
      submission.users = users;
    }
    return submission;
  };

  return (
    <form
      className="flex flex-col"
      onSubmit={form.handleSubmit(() => {
        const submission = buildSubmission();
        if (!submission) return;
        if (agent && Object.keys(submission).length === 0) {
          form.reset(valuesFromAgent(agent));
          return;
        }
        onSubmit(submission);
      })}
    >
      {readOnly ? (
        <Alert className="mb-4">
          <AlertDescription>
            You can view this external agent, but you do not have permission to
            change its connection or access settings.
          </AlertDescription>
        </Alert>
      ) : null}

      <fieldset disabled={readOnly} className="contents">
        <SettingsSectionGroup>
          <SettingsSection
            title="Agent Card"
            description="Enter the external agent's base URL. The Agent Card is discovered automatically."
          >
            <div className="space-y-2">
              <Label htmlFor="a2a-url">Agent base URL</Label>
              <Input
                id="a2a-url"
                type="url"
                disabled={readOnly}
                placeholder="https://agent.example.com"
                {...form.register("url", {
                  required: keepsLegacySource
                    ? false
                    : "An agent base URL is required.",
                  validate: (value) => {
                    if (keepsLegacySource && !value.trim()) return true;
                    return (
                      !!normalizeAgentBaseUrl(value.trim()) ||
                      "Enter a base URL without a path, query, or fragment."
                    );
                  },
                  onChange: requestInspection,
                })}
              />
              <FieldDescription>
                {keepsLegacySource
                  ? readOnly
                    ? "This connection uses a legacy Agent Card source."
                    : "This connection uses a legacy Agent Card source. Leave this blank to keep it, or enter a base URL to replace it."
                  : "We'll discover the Agent Card at /.well-known/agent-card.json."}
              </FieldDescription>
              {form.formState.errors.url ? (
                <p role="alert" className="text-sm text-destructive">
                  {form.formState.errors.url.message}
                </p>
              ) : null}
              {inspectMutation.isPending ? (
                <output className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Looking for the Agent Card…</span>
                </output>
              ) : null}
              {inspectMutation.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {getApiErrorMessage(inspectMutation.error)}
                </p>
              ) : null}
              {inspectMutation.data ? (
                <output
                  aria-label="Agent Card found"
                  className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm"
                >
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" />
                  <div>
                    <p className="font-medium">{inspectMutation.data.name}</p>
                    <p className="text-muted-foreground">
                      {inspectMutation.data.selectedInterface.protocolBinding} ·{" "}
                      {inspectMutation.data.selectedInterface.protocolVersion}
                    </p>
                  </div>
                </output>
              ) : null}
            </div>
          </SettingsSection>

          <SettingsSection
            title="Authentication"
            description="Configure how Archestra authenticates requests to this external agent."
          >
            <div className="space-y-2">
              <Label htmlFor="a2a-auth">Authentication</Label>
              <Select
                value={authType}
                disabled={readOnly}
                onValueChange={(value) => {
                  updateControlled("authType", value as AuthType);
                }}
              >
                <SelectTrigger id="a2a-auth">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="bearer">Bearer token</SelectItem>
                  <SelectItem value="api_key">API key header</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {authType === "api_key" ? (
              <div className="space-y-2">
                <Label htmlFor="a2a-header">Header name</Label>
                <Input
                  id="a2a-header"
                  disabled={readOnly}
                  {...form.register("headerName", {
                    required: "A header name is required.",
                  })}
                />
              </div>
            ) : null}
            {authType !== "none" ? (
              <div className="space-y-2">
                {readOnly ? (
                  <>
                    <Label>Credential</Label>
                    <FieldDescription>
                      {agent?.connection.hasCredential
                        ? "A credential is configured for this connection."
                        : "No credential is configured for this connection."}
                    </FieldDescription>
                  </>
                ) : (
                  <Label htmlFor="a2a-credential">
                    {agent?.connection.hasCredential
                      ? "Replace credential (optional)"
                      : "Credential"}
                  </Label>
                )}
                {!readOnly && agent?.connection.hasCredential ? (
                  <FieldDescription>
                    A credential is already stored. Leave this blank to keep it,
                    or enter a new value to replace it.
                  </FieldDescription>
                ) : null}
                {!readOnly ? (
                  <SecretInput
                    id="a2a-credential"
                    revealable
                    placeholder={
                      agent?.connection.hasCredential ? "••••••••" : undefined
                    }
                    {...form.register("credential")}
                  />
                ) : null}
                {form.formState.errors.credential ? (
                  <p role="alert" className="text-sm text-destructive">
                    {form.formState.errors.credential.message}
                  </p>
                ) : null}
              </div>
            ) : null}
          </SettingsSection>

          <SettingsSection
            title="Details"
            description="Override the name or description published by the Agent Card."
          >
            <div className="space-y-2">
              <Label htmlFor="a2a-name">Display name (optional)</Label>
              <Input
                id="a2a-name"
                disabled={readOnly}
                placeholder="Uses the Agent Card name"
                {...form.register("name")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="a2a-description">Description (optional)</Label>
              <Textarea
                id="a2a-description"
                rows={3}
                disabled={readOnly}
                placeholder="Uses the Agent Card description"
                {...form.register("description")}
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Access"
            description="Choose who can discover and assign this external agent."
          >
            {readOnly && agent ? (
              <ResourceVisibilityBadge
                scope={agent.scope}
                teams={agent.teams}
                users={agent.users}
                authorId={agent.authorId}
                authorName={agent.authorName}
                currentUserId={session?.user?.id}
                showSelfAsMe
              />
            ) : (
              <A2aRemoteAgentScopeSelector
                scope={scope}
                onScopeChange={(value) => updateControlled("scope", value)}
                teamIds={teamIds}
                onTeamIdsChange={(value) => updateControlled("teamIds", value)}
                userIds={userIds}
                onUserIdsChange={(value) => updateControlled("userIds", value)}
              />
            )}
            {form.formState.errors.teamIds ? (
              <p role="alert" className="text-sm text-destructive">
                {form.formState.errors.teamIds.message}
              </p>
            ) : null}
            {form.formState.errors.userIds ? (
              <p role="alert" className="text-sm text-destructive">
                {form.formState.errors.userIds.message}
              </p>
            ) : null}
          </SettingsSection>
        </SettingsSectionGroup>
      </fieldset>

      {!readOnly ? (
        <WizardFooter
          className={agent ? "border-t-0 sm:justify-end" : undefined}
        >
          {!agent ? (
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={onCancel}
            >
              Cancel
            </Button>
          ) : null}
          <Button
            type="submit"
            disabled={
              isSaving ||
              (!!agent &&
                !form.formState.isDirty &&
                !inspectionNeedsPersistence)
            }
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            <span>
              {isSaving
                ? agent
                  ? "Saving…"
                  : "Connecting…"
                : agent
                  ? "Save changes"
                  : "Connect agent"}
            </span>
          </Button>
        </WizardFooter>
      ) : null}
    </form>
  );
}

function valuesFromAgent(agent?: A2aRemoteAgent): FormValues {
  return {
    url: storedWellKnownBaseUrl(agent) ?? "",
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    authType: agent?.connection.authType ?? "none",
    headerName: agent?.connection.authConfig.headerName ?? "X-API-Key",
    credential: "",
    scope: agent?.scope ?? "personal",
    teamIds: agent?.teams.map((team) => team.id) ?? [],
    userIds: agent?.users.map((user) => user.id) ?? [],
  };
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
  if (agent && !storedWellKnownBaseUrl(agent) && !enteredUrl) {
    return undefined;
  }
  const url = normalizeAgentBaseUrl(enteredUrl);
  if (!url) {
    form.setError("url", {
      message: "Enter a base URL without a path, query, or fragment.",
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
  if (values.authType === "none") {
    return agent?.connection.authType === "none" ? undefined : { type: "none" };
  }

  const credential = values.credential.trim();
  const keepsStoredCredential =
    !!agent?.connection.hasCredential &&
    values.authType === agent.connection.authType &&
    (values.authType !== "api_key" ||
      values.headerName.trim() ===
        (agent.connection.authConfig.headerName ?? "X-API-Key"));
  if (!credential && keepsStoredCredential) return undefined;
  if (!credential) {
    form.setError("credential", {
      message: agent
        ? "Enter a credential when changing authentication."
        : "A credential is required.",
    });
    return null;
  }
  if (values.authType === "bearer") {
    return { type: "bearer", credential };
  }
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

function storedWellKnownBaseUrl(agent?: A2aRemoteAgent) {
  if (agent?.discoveryMode !== "well_known" || !agent.discoveryUrl) {
    return null;
  }
  return normalizeAgentBaseUrl(agent.discoveryUrl);
}

function normalizeAgentBaseUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}
