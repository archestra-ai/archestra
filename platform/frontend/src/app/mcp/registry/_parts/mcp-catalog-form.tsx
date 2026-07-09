"use client";

import { type archestraApiTypes, DocsPage } from "@archestra/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertTriangle,
  Ban,
  Code,
  ExternalLink,
  Globe,
  IdCard,
  KeyRound,
  Lock,
  Plus,
  Server,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { lazy, useEffect, useMemo, useRef, useState } from "react";
import { type UseFormReturn, useFieldArray, useForm } from "react-hook-form";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentIconPicker } from "@/components/agent-icon-picker";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import {
  type EnterpriseManagedConfigInput,
  EnterpriseManagedCredentialFields,
} from "@/components/enterprise-managed-credential-fields";
import { EnvironmentSelector } from "@/components/environment-selector";
import { EnvironmentVariablesFormField } from "@/components/environment-variables-form-field";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { HeaderDialog, type HeaderDraft } from "@/components/header-dialog";
import { HeadersReadOnlyTable } from "@/components/headers-read-only-table";
import { ReinstallConfirmBar } from "@/components/reinstall-confirm-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { SecretInput } from "@/components/ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { LOCAL_MCP_DISABLED_MESSAGE } from "@/consts";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { useEnterpriseFeature, useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useEnvironments } from "@/lib/environment.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useK8sImagePullSecrets } from "@/lib/mcp/internal-mcp-catalog.query";
import { MCP_CONFIG_AUTOCOMPLETE } from "@/lib/mcp/mcp-form-autocomplete";
import { useDefaultEnvironment } from "@/lib/organization.query";
import { useGetSecret } from "@/lib/secrets.query";
import { useAssignableTeams } from "@/lib/teams/team.query";
import {
  type CascadeSnapshot,
  computeCascadeOutcome,
} from "./cascade-decision";
import {
  compileValidationRegex,
  validateFieldAgainstRegex,
} from "./environment-validation-helpers";
import {
  formSchema,
  type McpCatalogFormValues,
} from "./mcp-catalog-form.types";
import {
  transformCatalogItemToFormValues,
  transformFormToApiData,
} from "./mcp-catalog-form.utils";

const ExternalSecretSelector = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("@/components/external-secret-selector.ee"),
);

// Markdown renderer for catalog-supplied setup instructions shown atop the form.
const INSTRUCTIONS_MARKDOWN_COMPONENTS: Components = {
  p: ({ node, ...props }) => (
    <p className="mb-2 text-muted-foreground" {...props} />
  ),
  strong: ({ node, ...props }) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
  ol: ({ node, ...props }) => (
    <ol
      className="mb-2 list-decimal space-y-1 pl-5 text-muted-foreground"
      {...props}
    />
  ),
  ul: ({ node, ...props }) => (
    <ul
      className="mb-2 list-disc space-y-1 pl-5 text-muted-foreground"
      {...props}
    />
  ),
  a: ({ node, children, ...props }) => (
    <a
      className="text-primary underline"
      target="_blank"
      rel="noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  pre: ({ node, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-xs"
      {...props}
    />
  ),
  code: ({ node, ...props }) => (
    <code
      className="rounded bg-muted px-1 py-0.5 font-mono text-xs"
      {...props}
    />
  ),
};

interface McpCatalogFormProps {
  mode: "create" | "edit";
  initialValues?: archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];
  onSubmit: (
    values: McpCatalogFormValues,
    form: UseFormReturn<McpCatalogFormValues>,
  ) => void | Promise<void>;
  footer?:
    | React.ReactNode
    | ((opts: {
        isDirty: boolean;
        onReset: () => void;
        /**
         * True when stored config values violate the bound environment's
         * validation rule — the footer's Save button should disable on it.
         * Saving is also guarded internally, but disabling gives a visible cue.
         */
        hasBlockingErrors: boolean;
      }) => React.ReactNode);
  nameDisabled?: boolean;
  catalogButton?: React.ReactNode;
  /** Optional banner/notice rendered at the very top of the form body. */
  notice?: React.ReactNode;
  formValues?: McpCatalogFormValues;
  /** Called when form dirty state changes */
  onDirtyChange?: (isDirty: boolean) => void;
  /** Ref to imperatively trigger form submission */
  submitRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  embedded?: boolean;
  /**
   * Number of installed servers that would be affected by a cascade
   * reinstall. Drives the inline confirm bar copy in edit mode. Defaults
   * to 0 (no confirm bar — used for create mode and standalone previews).
   */
  affectedServerCount?: number;
}

export function McpCatalogForm({
  mode,
  initialValues,
  onSubmit,
  nameDisabled,
  footer,
  catalogButton,
  notice,
  formValues,
  onDirtyChange,
  submitRef,
  embedded = false,
  affectedServerCount = 0,
}: McpCatalogFormProps) {
  const localConfigSecretId =
    initialValues?.serverType === "local"
      ? initialValues.localConfigSecretId
      : null;
  // Fetch local config secrets only for local MCP catalog items.
  const { data: localConfigSecret } = useGetSecret(localConfigSecretId);

  // Pre-existing secret env-var keys, used to render a `••••••••` placeholder.
  const storedSecretKeys = useMemo(() => {
    if (initialValues?.serverType !== "local" || !initialValues.localConfig) {
      return new Set<string>();
    }
    return new Set(
      (initialValues.localConfig.environment ?? [])
        .filter((env) => env.type === "secret")
        .map((env) => env.key),
    );
  }, [initialValues]);

  // Get MCP server base image from backend features endpoint
  const mcpServerBaseImage = useFeature("mcpServerBaseImage") ?? "";

  const isLocalMcpEnabled = useFeature("orchestratorK8sRuntime");
  const isEnterpriseCoreEnabled = useEnterpriseFeature("core");
  const appName = useAppName();
  const mcpAuthDocsUrl = getFrontendDocsUrl(
    DocsPage.McpAuthentication,
    "upstream-mcp-server-authentication",
  );
  const mcpAuthTokenExchangeDocsUrl = getFrontendDocsUrl(
    DocsPage.McpAuthentication,
    "token-exchange-configuration",
  );
  const mcpAuthJwksDocsUrl = getFrontendDocsUrl(
    DocsPage.McpAuthentication,
    "upstream-identity-provider-jwt-jwks",
  );
  const { data: canReadIdentityProviders } = useHasPermissions({
    identityProvider: ["read"],
  });
  const { data: identityProviders = [] } = useIdentityProviders({
    enabled: isEnterpriseCoreEnabled && !!canReadIdentityProviders,
  });
  const oidcIdentityProviders = useMemo(
    () => identityProviders.filter((provider) => provider.oidcConfig != null),
    [identityProviders],
  );
  const hasOidcIdentityProviders = oidcIdentityProviders.length > 0;
  const defaultIdentityProviderId =
    oidcIdentityProviders.length === 1 ? oidcIdentityProviders[0]?.id : null;

  const form = useForm<McpCatalogFormValues>({
    // biome-ignore lint/suspicious/noExplicitAny: Version mismatch between @hookform/resolvers and Zod
    resolver: zodResolver(formSchema as any),
    defaultValues: initialValues
      ? transformCatalogItemToFormValues(initialValues, undefined)
      : (formValues ?? {
          name: "",
          description: "",
          icon: null,
          serverType: "remote",
          multitenant: false,
          serverUrl: "",
          authMethod: "none",
          includeBearerPrefix: true,
          authHeaderName: "",
          additionalHeaders: [],
          enterpriseManagedConfig: null,
          oauthConfig: {
            client_id: "",
            client_secret: "",
            audience: "",
            redirect_uris:
              typeof window !== "undefined"
                ? `${window.location.origin}/oauth-callback`
                : "",
            scopes: "read, write",
            additional_scopes: "offline_access",
            supports_resource_metadata: true,
            grantType: "authorization_code",
            authServerUrl: "",
            authorizationEndpoint: "",
            wellKnownUrl: "",
            resourceMetadataUrl: "",
            tokenEndpoint: "",
          },
          localConfig: {
            command: "",
            arguments: "",
            environment: [],
            envFrom: [],
            dockerImage: "",
            transportType: "streamable-http",
            httpPort: "",
            httpPath: "/mcp",
            serviceAccount: "",
            imagePullSecrets: [],
          },
          scope: "personal",
          teams: [],
          environmentId: null,
        }),
  });

  // Expose imperative submit to parent
  useEffect(() => {
    if (submitRef) {
      submitRef.current = form.handleSubmit((values) =>
        onSubmit(values, form),
      ) as () => Promise<void>;
    }
    return () => {
      if (submitRef) submitRef.current = null;
    };
  }, [submitRef, form, onSubmit]);

  const authMethod = form.watch("authMethod");
  const instructions = form.watch("instructions");
  const currentServerType = form.watch("serverType");
  const currentTransportType = form.watch("localConfig.transportType");
  const isMultitenant = Boolean(form.watch("multitenant"));
  const isTenancyLocked = Boolean(initialValues);
  const selectedIdentityProviderId = form.watch(
    "enterpriseManagedConfig.identityProviderId",
  );

  const handleAuthMethodChange = (
    nextAuthMethod: McpCatalogFormValues["authMethod"],
  ) => {
    const previousAuthMethod = form.getValues("authMethod");
    form.setValue("authMethod", nextAuthMethod, { shouldDirty: true });

    if (
      previousAuthMethod === "auth_header" &&
      nextAuthMethod !== "auth_header"
    ) {
      const existingHeaders = form.getValues("additionalHeaders") ?? [];
      const filtered = existingHeaders.filter(
        (header) => !header.includeBearerPrefix,
      );
      if (filtered.length !== existingHeaders.length) {
        form.setValue("additionalHeaders", filtered, { shouldDirty: true });
      }
    }

    if (
      nextAuthMethod === "oauth" ||
      nextAuthMethod === "oauth_client_credentials"
    ) {
      form.setValue(
        "oauthConfig.grantType",
        nextAuthMethod === "oauth"
          ? "authorization_code"
          : "client_credentials",
        { shouldDirty: true },
      );
    }

    if (nextAuthMethod === "enterprise_managed") {
      form.setValue(
        "enterpriseManagedConfig",
        {
          ...(form.getValues("enterpriseManagedConfig") ?? {}),
          identityProviderId:
            form.getValues("enterpriseManagedConfig.identityProviderId") ??
            defaultIdentityProviderId ??
            undefined,
          assertionMode: "exchange",
        },
        { shouldDirty: true },
      );
      return;
    }

    if (nextAuthMethod === "idp_jwt") {
      form.setValue(
        "enterpriseManagedConfig",
        {
          identityProviderId:
            form.getValues("enterpriseManagedConfig.identityProviderId") ??
            defaultIdentityProviderId ??
            undefined,
          assertionMode: "passthrough",
          requestedCredentialType: "bearer_token",
          tokenInjectionMode: "authorization_bearer",
        },
        { shouldDirty: true },
      );
      return;
    }

    if (nextAuthMethod === "auth_header") {
      const existingHeaders = form.getValues("additionalHeaders") ?? [];
      const hasAuthHeader = existingHeaders.some(
        (header) => header.includeBearerPrefix,
      );
      if (!hasAuthHeader) {
        // Bearer-token credential — always sensitive. The Add Header
        // dialog forces this choice on manual additions, but the
        // token-auth flow seeds the row programmatically and so must
        // own the default itself.
        appendAdditionalHeader({
          fieldName: undefined,
          headerName: "Authorization",
          promptOnInstallation: true,
          required: true,
          value: "",
          description: "",
          includeBearerPrefix: true,
          sensitive: true,
        });
      }
    }

    form.setValue("enterpriseManagedConfig", null, { shouldDirty: true });
  };

  useEffect(() => {
    if (
      (!isEnterpriseCoreEnabled || !hasOidcIdentityProviders) &&
      (authMethod === "enterprise_managed" || authMethod === "idp_jwt")
    ) {
      form.setValue("authMethod", "none", { shouldDirty: true });
      form.setValue("enterpriseManagedConfig", null, { shouldDirty: true });
    }
  }, [authMethod, form, hasOidcIdentityProviders, isEnterpriseCoreEnabled]);

  const handleMultitenantChange = (nextMultitenant: boolean) => {
    form.setValue("multitenant", nextMultitenant, { shouldDirty: true });

    if (!nextMultitenant) {
      handleAuthMethodChange("none");
      return;
    }

    const envVars = form.getValues("localConfig.environment") ?? [];
    const next = envVars.map((envVar) =>
      envVar.promptOnInstallation
        ? { ...envVar, promptOnInstallation: false, required: false }
        : envVar,
    );
    if (next.some((envVar, i) => envVar !== envVars[i])) {
      form.setValue("localConfig.environment", next, { shouldDirty: true });
    }
  };

  useEffect(() => {
    if (
      defaultIdentityProviderId &&
      (authMethod === "enterprise_managed" || authMethod === "idp_jwt") &&
      !selectedIdentityProviderId
    ) {
      form.setValue(
        "enterpriseManagedConfig.identityProviderId",
        defaultIdentityProviderId,
        { shouldDirty: true },
      );
    }
  }, [authMethod, defaultIdentityProviderId, form, selectedIdentityProviderId]);

  // BYOS (Bring Your Own Secrets) state for OAuth
  const [oauthVaultTeamId, setOauthVaultTeamId] = useState<string | null>(null);
  const [oauthVaultSecretPath, setOauthVaultSecretPath] = useState<
    string | null
  >(null);
  const [oauthVaultSecretKey, setOauthVaultSecretKey] = useState<string | null>(
    null,
  );

  // Baseline `additionalHeaders` derived from `initialValues.userConfig`.
  // Used by `isHeadersDirty`'s schema-evolution check — RHF's
  // `dirtyFields.additionalHeaders` only tells us SOMETHING in the
  // array changed; we need the actual prev shape to classify what kind
  // of change (forward-compatible vs breaking).
  const initialAdditionalHeaders = useMemo(
    () => deriveAdditionalHeaders(initialValues?.userConfig),
    [initialValues?.userConfig],
  );

  // Labels state (managed separately from react-hook-form)
  const initialLabelsFromProps = useMemo(
    () =>
      initialValues?.labels?.map((l) => ({ key: l.key, value: l.value })) ?? [],
    [initialValues?.labels],
  );
  const [labels, setLabels] = useState<ProfileLabel[]>(initialLabelsFromProps);
  // Baseline for dirty comparison; updated after save to mirror form.reset behavior
  const [labelsBaseline, setLabelsBaseline] = useState<ProfileLabel[]>(
    initialLabelsFromProps,
  );
  const labelsRef = useRef<ProfileLabelsRef>(null);

  // Report dirty state to parent (includes label changes)
  const { isDirty: isFormDirty, dirtyFields } = form.formState;

  // Granular dirty flags used to show contextual reinstall hints in edit mode.
  // Editing any of these on a deployed catalog item invalidates existing install
  // credentials or redeploys the pod — admins must reinstall + re-enter creds.
  //
  // CAVEAT — react-hook-form's `dirtyFields` representation: for ARRAYS
  // (additionalHeaders, localConfig.environment), it allocates an entry per
  // array index with every leaf as a boolean. A form initialized with
  // `additionalHeaders: [{...}]` (e.g., one header derived from userConfig)
  // produces `dirtyFields.additionalHeaders = [{...all leaves false}]` —
  // a NON-EMPTY ARRAY that is `Boolean(...)`-truthy even though nothing
  // was actually edited. `isReallyDirty` walks the tree and only returns
  // true when SOME leaf is actually true.
  const isNameDirty = mode === "edit" && isReallyDirty(dirtyFields.name);
  const isServerUrlDirty =
    mode === "edit" && isReallyDirty(dirtyFields.serverUrl);
  const isAuthDirty =
    mode === "edit" &&
    (isReallyDirty(dirtyFields.authMethod) ||
      isReallyDirty(dirtyFields.authHeaderName) ||
      isReallyDirty(dirtyFields.includeBearerPrefix) ||
      isReallyDirty(dirtyFields.oauthConfig) ||
      isReallyDirty(dirtyFields.enterpriseManagedConfig));
  // Env-var dirtiness alone isn't enough to require reinstall — adding an
  // OPTIONAL prompted env var leaves existing installs valid (they just
  // don't fill the new var). Mirror the backend's `promptedEnvVarsChanged`
  // schema-evolution rules in `backend/src/services/mcp-reinstall.ts` so
  // the bar's prediction matches what the backend will actually do.
  const isEnvDirty =
    mode === "edit" &&
    isReallyDirty(dirtyFields.localConfig?.environment) &&
    envChangeRequiresReinstall(
      initialValues?.localConfig?.environment,
      form.watch("localConfig.environment"),
    );
  // Same shape as `isEnvDirty` — `additionalHeaders` array dirty is too
  // coarse on its own (adding an OPTIONAL per-install header is forward-
  // compatible — existing installs that don't fill it stay valid).
  // Mirror of backend's userConfig schema-evolution semantics, see
  // `additionalHeadersChangeRequiresReinstall` below.
  const isHeadersDirty =
    mode === "edit" &&
    isReallyDirty(dirtyFields.additionalHeaders) &&
    additionalHeadersChangeRequiresReinstall(
      initialAdditionalHeaders,
      form.watch("additionalHeaders"),
    );
  // Per-field deployment dirty flags. Each of these maps to a field in the
  // backend's `localExecutionConfigChanged` heuristic
  // (backend/src/services/mcp-reinstall.ts).
  const localConfigDirty = dirtyFields.localConfig as
    | Record<string, unknown>
    | undefined;
  const deploymentField = (key: string) =>
    mode === "edit" && isReallyDirty(localConfigDirty?.[key]);
  const isCommandDirty = deploymentField("command");
  const isArgumentsDirty = deploymentField("arguments");
  const isDockerImageDirty = deploymentField("dockerImage");
  const isTransportTypeDirty = deploymentField("transportType");
  const isHttpPortDirty = deploymentField("httpPort");
  const isHttpPathDirty = deploymentField("httpPath");

  // The per-field `is*Dirty` flags below drive `ReinstallHint` badges
  // next to individual inputs. The form-level cascade decision lives in
  // `computeCascadeOutcome` (cascade-decision.ts).
  const areLabelsChanged = useMemo(() => {
    if (labels.length !== labelsBaseline.length) return true;
    return labels.some(
      (l, i) =>
        l.key !== labelsBaseline[i].key || l.value !== labelsBaseline[i].value,
    );
  }, [labels, labelsBaseline]);
  const isDirty = isFormDirty || areLabelsChanged;
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // Check admin status for scope options
  const { data: isAdmin } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  // All teams for a full admin, otherwise only the user's own teams (the only
  // ones the backend lets a non-admin assign).
  const { data: teams } = useAssignableTeams({
    isResourceAdmin: !!isAdmin,
    enabled: !!canReadTeams,
  });
  // Sharing with a team requires administering it (admins bypass), matching the
  // backend gate. `myRole` is populated only on the caller's own teams.
  const administersATeam = (teams ?? []).some((t) => t.myRole === "admin");
  const { data: environmentList } = useEnvironments();
  const environments = environmentList?.environments;
  const defaultEnvironment = useDefaultEnvironment();
  // Validate static config values (env vars + headers) against the rule of the
  // environment this item is bound to (or the org default when unbound), so a
  // forbidden value is flagged inline and can't be saved. Passed to both
  // EnvironmentVariablesFormField instances below.
  const watchedEnvironmentId = form.watch("environmentId");
  const boundEnvironment = watchedEnvironmentId
    ? environments?.find((e) => e.id === watchedEnvironmentId)
    : null;
  const boundEnvironmentName =
    boundEnvironment?.name ?? defaultEnvironment.name;
  const boundValidationRegex = compileValidationRegex(
    boundEnvironment
      ? boundEnvironment.validationRegex
      : defaultEnvironment.validationRegex,
  );
  const validateConfigValue = boundValidationRegex
    ? (value: string): string | null =>
        validateFieldAgainstRegex({
          value,
          regex: boundValidationRegex,
          valueType: "string",
          environmentName: boundEnvironmentName,
        })
    : undefined;
  // Already-stored static values that violate the bound environment's rule —
  // e.g. after switching the item to a stricter environment. The add/edit
  // dialogs block typing a bad value, but a value entered under a laxer
  // environment only surfaces here, where it blocks Save until fixed.
  //
  // Only scan the fields actually live for the current server type: env vars
  // for local, headers for remote. A local server submits no headers and a
  // remote one submits no localConfig.environment, so scanning the inactive
  // (and hidden) set would block Save on a field the user can't even see.
  const watchedEnvVars = form.watch("localConfig.environment");
  const watchedHeaders = form.watch("additionalHeaders");
  const envRuleViolations: string[] = [];
  if (validateConfigValue) {
    if (currentServerType === "local") {
      for (const envVar of watchedEnvVars ?? []) {
        if (
          envVar.type === "plain_text" &&
          !envVar.promptOnInstallation &&
          envVar.value &&
          validateConfigValue(envVar.value)
        ) {
          envRuleViolations.push(envVar.key);
        }
      }
    } else {
      for (const header of watchedHeaders ?? []) {
        if (
          !header.promptOnInstallation &&
          !header.sensitive &&
          header.value &&
          validateConfigValue(header.value)
        ) {
          envRuleViolations.push(header.headerName);
        }
      }
    }
  }
  const hasEnvRuleViolations = envRuleViolations.length > 0;
  const currentScope = form.watch("scope");
  const selectedTeams = form.watch("teams") ?? [];
  // A team-scoped item may be shared with teams the editor doesn't belong to,
  // which the assignable-teams picker never lists — take their names from the
  // item so the access rows never fall back to a raw id.
  const teamNameById = useMemo(
    () =>
      new Map([
        ...(initialValues?.teams ?? []).map(
          (t) => [t.id, t.name] as [string, string],
        ),
        ...(teams ?? []).map((t) => [t.id, t.name] as [string, string]),
      ]),
    [initialValues, teams],
  );
  const canShareWithTeams = (isAdmin ?? false) || administersATeam;
  // Shared items are one-way: an item that is already team/org-scoped cannot be
  // demoted back to personal (mirrors the agent dialog).
  const initialScope = initialValues?.scope;
  const enterpriseAuthDisabledReason: ReactNode | null =
    !isEnterpriseCoreEnabled
      ? "Available with the Enterprise Core license."
      : null;
  const enterpriseAuthDisabledBadge: ReactNode | null =
    isEnterpriseCoreEnabled && !hasOidcIdentityProviders ? (
      <Link
        href="/settings/identity-providers"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center"
        onClick={(event) => event.stopPropagation()}
      >
        <Badge
          variant="secondary"
          className="text-[10px] tracking-wide hover:bg-secondary/80"
        >
          OIDC not configured
          <ExternalLink className="ml-1 h-3 w-3" />
        </Badge>
      </Link>
    ) : null;
  const enterpriseAuthDisabled =
    enterpriseAuthDisabledReason != null || enterpriseAuthDisabledBadge != null;
  const visibilityOptions = useMemo<
    Array<VisibilityOption<"personal" | "team" | "org">>
  >(
    () => [
      {
        value: "personal",
        label: "Personal",
        description: "Only you can access this MCP server.",
        icon: Lock,
        disabled: initialScope != null && initialScope !== "personal",
        disabledReason: "Shared MCP servers cannot be made personal.",
      },
      {
        value: "team",
        label: "Teams",
        description: "Share this MCP server with selected teams.",
        icon: Users,
        disabled: !canShareWithTeams || !canReadTeams || !teams?.length,
        disabledReason: !canReadTeams
          ? "Team sharing is unavailable without team:read permission."
          : !canShareWithTeams
            ? "You need to be an admin of a team to share with it."
            : "Create a team first to share this MCP server.",
      },
      {
        value: "org",
        label: "Organization",
        description:
          "Everyone in your organization can use this MCP server. Only admins can modify it.",
        icon: Globe,
        disabled: !isAdmin,
        disabledReason: "Only admins can make MCP servers organization-wide.",
      },
    ],
    [isAdmin, canShareWithTeams, canReadTeams, teams, initialScope],
  );

  // Check if BYOS feature is available (enterprise license)
  const showByosOption = useFeature("byosEnabled");

  // Use field array for environment variables
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "localConfig.environment",
  });

  // Use field array for envFrom (existing K8s Secrets/ConfigMaps)
  const {
    fields: envFromFields,
    append: appendEnvFrom,
    remove: removeEnvFrom,
  } = useFieldArray({
    control: form.control,
    name: "localConfig.envFrom",
  });

  // Use field array for imagePullSecrets
  const {
    fields: imagePullSecretFields,
    append: appendImagePullSecret,
    remove: removeImagePullSecret,
    update: updateImagePullSecret,
  } = useFieldArray({
    control: form.control,
    name: "localConfig.imagePullSecrets",
  });

  const {
    fields: additionalHeaderFields,
    append: appendAdditionalHeader,
    remove: removeAdditionalHeader,
  } = useFieldArray({
    control: form.control,
    name: "additionalHeaders",
  });

  const [headerDialog, setHeaderDialog] = useState<
    { mode: "add" } | { mode: "edit"; index: number } | null
  >(null);

  // Fetch available k8s docker-registry secrets for the "existing" dropdown
  const { data: k8sSecrets = [] } = useK8sImagePullSecrets();
  const imagePullSecretItems = useMemo(
    () =>
      k8sSecrets.map((secret) => {
        const registryLabel = formatRegistryServers(secret.registryServers);
        const primaryLabel = registryLabel || secret.name;
        const secondaryLabel = registryLabel ? secret.name : undefined;

        return {
          value: secret.name,
          label: primaryLabel,
          searchText: [secret.name, ...secret.registryServers].join(" "),
          content: (
            <span className="block min-w-0">
              <span className="block truncate font-medium">{primaryLabel}</span>
              {secondaryLabel ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {secondaryLabel}
                </span>
              ) : null}
            </span>
          ),
          selectedContent: (
            <span className="block min-w-0">
              <span className="block truncate">{primaryLabel}</span>
              {secondaryLabel ? (
                <span className="block truncate text-xs text-muted-foreground">
                  {secondaryLabel}
                </span>
              ) : null}
            </span>
          ),
        };
      }),
    [k8sSecrets],
  );

  // Update form values when BYOS paths/keys change
  useEffect(() => {
    form.setValue(
      "oauthClientSecretVaultPath",
      oauthVaultSecretPath || undefined,
    );
    form.setValue(
      "oauthClientSecretVaultKey",
      oauthVaultSecretKey || undefined,
    );
  }, [oauthVaultSecretPath, oauthVaultSecretKey, form]);

  // Reset form when formValues change (catalog pre-fill in create mode)
  useEffect(() => {
    if (formValues && !initialValues) {
      form.reset(formValues);
      setLabels(
        formValues.labels?.map((l) => ({ key: l.key, value: l.value })) ?? [],
      );
    }
  }, [formValues, initialValues, form]);

  // Reset form when initial values change (for edit mode)
  // Also reset when localConfigSecret loads (if it exists)
  useEffect(() => {
    if (initialValues) {
      const transformedValues = transformCatalogItemToFormValues(
        initialValues,
        localConfigSecret ?? undefined,
      );
      form.reset(transformedValues);
      // Reset labels state
      const resetLabels =
        initialValues.labels?.map((l) => ({ key: l.key, value: l.value })) ??
        [];
      setLabels(resetLabels);
      setLabelsBaseline(resetLabels);
      // Initialize OAuth BYOS state from transformed values (parsed vault references)
      // Note: teamId cannot be derived from path, so we leave it null (user can reselect if needed)
      setOauthVaultTeamId(null);
      setOauthVaultSecretPath(
        transformedValues.oauthClientSecretVaultPath || null,
      );
      setOauthVaultSecretKey(
        transformedValues.oauthClientSecretVaultKey || null,
      );
    }
  }, [initialValues, localConfigSecret, form]);

  // The bar's mode is captured at submit-time so the bar stays consistent
  // even if the form state drifts during the confirm step. `null` means
  // no bar.
  const [pendingSubmit, setPendingSubmit] = useState<{
    values: McpCatalogFormValues;
    mode: "manual" | "auto";
  } | null>(null);
  // `form.formState.isSubmitting` clears the moment `handleSubmit`
  // returns (which we do early to show the bar), so it can't drive the
  // bar's spinner — track the bar→save phase ourselves.
  const [isConfirming, setIsConfirming] = useState(false);
  // A synchronous in-flight latch. The Save button's `disabled` reflects the
  // mutation's `isPending`, but that is React state and only takes effect on
  // the next render — a fast double-click fires two submits before it flips.
  // Two concurrent saves race the team-assignment delete-then-reinsert and the
  // loser hits a unique-constraint violation. This latch drops the second call.
  const submitInFlightRef = useRef(false);

  const performSubmit = async (values: McpCatalogFormValues) => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    try {
      // Save any unsaved label before submitting
      const updatedLabels = labelsRef.current?.saveUnsavedLabel() || labels;
      const submittedValues = { ...values, labels: updatedLabels };
      await onSubmit(submittedValues, form);
      // Reset baselines to what was just submitted so isDirty becomes false.
      // initialValues from the parent may not change reference after save
      // (TanStack Query structural sharing), and secret values are stored
      // separately so the catalog item itself may round-trip unchanged.
      form.reset(submittedValues, { keepValues: true });
      setLabelsBaseline(updatedLabels);
    } finally {
      submitInFlightRef.current = false;
    }
  };

  const handleSubmit = async (values: McpCatalogFormValues) => {
    // Stored values may violate the bound environment's rule (e.g. after an
    // environment switch). The Save button is disabled in that state, but guard
    // here too so an Enter-key submit can't bypass it.
    if (hasEnvRuleViolations) return;
    // Cascade-confirm decision delegated to a pure function so it can be
    // matrix-tested without rendering, and so frontend + backend share
    // the same decision tree shape. See `cascade-decision.ts`.
    if (mode === "edit") {
      const outcome = computeCascadeOutcome(
        (initialValues ?? {}) as CascadeSnapshot,
        transformFormToApiData(values) as CascadeSnapshot,
        { affectedServerCount },
      );
      if (outcome !== "skip") {
        setPendingSubmit({ values, mode: outcome });
        return;
      }
    }
    await performSubmit(values);
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="flex min-h-0 flex-1 flex-col"
        autoComplete={MCP_CONFIG_AUTOCOMPLETE}
        data-1p-ignore="true"
      >
        {/* Lock fields while the confirm bar is up AND during the save
            itself — keeps the snapshot the bar describes in sync with
            what the user sees on screen, and prevents silent data loss
            when a mid-bar edit gets dropped on confirm (the save uses
            `pendingSubmit.values`, the snapshot taken at first-save
            time, not the current form state). Matches the same pattern
            in `preset-editor-dialog.tsx`.

            `disabled` covers native form controls (input/select/button)
            but not the custom `<div role="button">` rows in the env-var
            and header tables (they CAN'T be real <button>s because they
            contain a nested delete <button>, and button-in-button is
            invalid HTML — see comments in those table components).
            `inert` blocks click + focus + keyboard for the entire
            subtree, catching the row-as-div case. The `opacity-60`
            class gives the user-visible "this is locked" signal that
            `inert` alone doesn't provide. */}
        <fieldset
          disabled={pendingSubmit !== null || isConfirming}
          inert={pendingSubmit !== null || isConfirming}
          className={`flex min-h-0 min-w-0 flex-1 flex-col m-0 p-0 border-0 transition-opacity ${
            pendingSubmit !== null || isConfirming ? "opacity-60" : ""
          }`}
        >
          <div
            className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 ${embedded ? "space-y-6 pt-6 pb-0" : "space-y-6 py-6"}`}
          >
            {notice}
            {instructions ? (
              <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={INSTRUCTIONS_MARKDOWN_COMPONENTS}
                >
                  {instructions}
                </ReactMarkdown>
              </div>
            ) : null}
            {catalogButton}

            <div className="space-y-4">
              <div className="flex items-stretch gap-3">
                <AgentIconPicker
                  value={form.watch("icon") ?? null}
                  fallbackType="server"
                  onChange={(icon) =>
                    form.setValue("icon", icon, { shouldDirty: true })
                  }
                  showLogos
                  className="h-auto w-16 self-stretch rounded-md"
                />
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        Name <span className="text-destructive">*</span>
                        <ReinstallHint show={isNameDirty} />
                      </FormLabel>
                      <FormControl>
                        {nameDisabled ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Input
                                placeholder="e.g., GitHub MCP Server"
                                {...field}
                                disabled
                              />
                            </TooltipTrigger>
                            <TooltipContent>
                              Name cannot be changed after the server is
                              created.
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Input
                            placeholder="e.g., GitHub MCP Server"
                            {...field}
                          />
                        )}
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Describe what this MCP server does..."
                        className="min-h-20"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="scope"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <VisibilitySelector
                        label="Access"
                        value={
                          (field.value ?? "personal") as
                            | "personal"
                            | "team"
                            | "org"
                        }
                        options={visibilityOptions}
                        onValueChange={(value) => {
                          field.onChange(value);
                          if (value !== "team") {
                            form.setValue("teams", [], { shouldDirty: true });
                          }
                        }}
                      >
                        {currentScope === "team" && (
                          <div className="space-y-6">
                            <div className="space-y-2">
                              <Label>Add Team</Label>
                              <SearchableSelect
                                value=""
                                onValueChange={(teamId) =>
                                  form.setValue(
                                    "teams",
                                    [
                                      ...selectedTeams,
                                      { id: teamId, level: "use" },
                                    ],
                                    { shouldDirty: true },
                                  )
                                }
                                items={(teams ?? []).map((t) => ({
                                  value: t.id,
                                  label: t.name,
                                  disabled: selectedTeams.some(
                                    (s) => s.id === t.id,
                                  ),
                                }))}
                                placeholder="Select a team"
                                searchPlaceholder="Search teams by name"
                                emptyMessage="No matching teams found."
                                className="w-full"
                              />
                            </div>

                            <div className="space-y-2">
                              <Label>Teams ({selectedTeams.length})</Label>
                              {selectedTeams.length === 0 ? (
                                <div className="rounded-lg border border-dashed p-4 text-center">
                                  <p className="text-sm text-muted-foreground">
                                    No teams added yet
                                  </p>
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  {selectedTeams.map((selected) => (
                                    <div
                                      key={selected.id}
                                      className="grid grid-cols-[minmax(0,1fr)_180px_40px] items-center gap-3 rounded-lg border p-3"
                                    >
                                      <p className="truncate text-sm font-medium">
                                        {teamNameById.get(selected.id) ??
                                          selected.id}
                                      </p>
                                      <Select
                                        value={selected.level}
                                        onValueChange={(level) =>
                                          form.setValue(
                                            "teams",
                                            selectedTeams.map((t) =>
                                              t.id === selected.id
                                                ? {
                                                    ...t,
                                                    level: level as
                                                      | "use"
                                                      | "write",
                                                  }
                                                : t,
                                            ),
                                            { shouldDirty: true },
                                          )
                                        }
                                      >
                                        <SelectTrigger className="w-full">
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="use">
                                            Use
                                          </SelectItem>
                                          <SelectItem value="write">
                                            Manage
                                          </SelectItem>
                                        </SelectContent>
                                      </Select>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() =>
                                          form.setValue(
                                            "teams",
                                            selectedTeams.filter(
                                              (t) => t.id !== selected.id,
                                            ),
                                            { shouldDirty: true },
                                          )
                                        }
                                      >
                                        <Trash2 className="h-4 w-4 text-destructive" />
                                        <span className="sr-only">
                                          Remove team
                                        </span>
                                      </Button>
                                    </div>
                                  ))}
                                  <FormDescription>
                                    <strong>Use</strong> — members can find this
                                    MCP server, install it for themselves, and
                                    use shared connections.{" "}
                                    <strong>Manage</strong> additionally lets
                                    the team&apos;s admins edit it, change its
                                    environment, and manage sharing.
                                  </FormDescription>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </VisibilitySelector>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="environmentId"
                render={({ field }) => (
                  <EnvironmentSelector
                    value={field.value ?? null}
                    onChange={field.onChange}
                  />
                )}
              />
              {hasEnvRuleViolations && (
                <div
                  role="alert"
                  className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-50/40 p-3 text-sm dark:bg-amber-950/20"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
                  <div className="space-y-1 text-foreground/90">
                    <div className="font-semibold text-foreground">
                      {envRuleViolations.length} value
                      {envRuleViolations.length === 1 ? "" : "s"} not allowed in
                      “{boundEnvironmentName}”
                    </div>
                    <div>
                      Edit or remove{" "}
                      {envRuleViolations.length === 1 ? "it" : "them"}, or
                      choose another environment, before saving:{" "}
                      <span className="font-mono">
                        {envRuleViolations.join(", ")}
                      </span>
                    </div>
                  </div>
                </div>
              )}
              {mode === "create" && (
                <div className="space-y-2">
                  <Label>Server Type</Label>
                  <div className="flex rounded-lg border border-border overflow-hidden">
                    <button
                      type="button"
                      onClick={() => form.setValue("serverType", "remote")}
                      className={`flex-1 flex flex-col items-center justify-center gap-0.5 px-4 py-2 text-sm font-medium transition-colors ${
                        currentServerType === "remote"
                          ? "bg-primary text-primary-foreground"
                          : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <Globe className="h-4 w-4" />
                        Remote
                      </span>
                      <span
                        className={`text-xs font-normal ${currentServerType === "remote" ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                      >
                        Orchestrated externally
                      </span>
                    </button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() =>
                            isLocalMcpEnabled &&
                            form.setValue("serverType", "local")
                          }
                          disabled={!isLocalMcpEnabled}
                          className={`flex-1 flex flex-col items-center justify-center gap-0.5 px-4 py-2 text-sm font-medium transition-colors border-l border-border ${
                            !isLocalMcpEnabled
                              ? "bg-background text-muted-foreground/50 cursor-not-allowed"
                              : currentServerType === "local"
                                ? "bg-primary text-primary-foreground"
                                : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted"
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <Server className="h-4 w-4" />
                            Self-hosted
                          </span>
                          <span
                            className={`text-xs font-normal ${!isLocalMcpEnabled ? "text-muted-foreground/50" : currentServerType === "local" ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                          >
                            Orchestrated in Kubernetes
                          </span>
                        </button>
                      </TooltipTrigger>
                      {!isLocalMcpEnabled && (
                        <TooltipContent>
                          <p className="max-w-xs">
                            {LOCAL_MCP_DISABLED_MESSAGE}
                          </p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </div>
                </div>
              )}
              {currentServerType === "local" && (
                <div className="space-y-2">
                  <Label>Tenancy</Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className={`flex rounded-lg border border-border overflow-hidden ${
                          isTenancyLocked ? "opacity-60" : ""
                        }`}
                      >
                        <button
                          type="button"
                          disabled={isTenancyLocked}
                          onClick={() => handleMultitenantChange(false)}
                          className={`flex-1 flex flex-col items-center justify-center gap-0.5 px-4 py-2 text-sm font-medium transition-colors ${
                            isTenancyLocked ? "cursor-not-allowed" : ""
                          } ${
                            !isMultitenant
                              ? "bg-primary text-primary-foreground"
                              : `bg-background text-muted-foreground ${
                                  isTenancyLocked
                                    ? ""
                                    : "hover:text-foreground hover:bg-muted"
                                }`
                          }`}
                        >
                          <span>Single-tenant</span>
                          <span
                            className={`text-xs font-normal ${!isMultitenant ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                          >
                            Dedicated deployment per installation
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={isTenancyLocked}
                          onClick={() => handleMultitenantChange(true)}
                          className={`flex-1 flex flex-col items-center justify-center gap-0.5 px-4 py-2 text-sm font-medium transition-colors border-l border-border ${
                            isTenancyLocked ? "cursor-not-allowed" : ""
                          } ${
                            isMultitenant
                              ? "bg-primary text-primary-foreground"
                              : `bg-background text-muted-foreground ${
                                  isTenancyLocked
                                    ? ""
                                    : "hover:text-foreground hover:bg-muted"
                                }`
                          }`}
                        >
                          <span>Multi-tenant</span>
                          <span
                            className={`text-xs font-normal ${isMultitenant ? "text-primary-foreground/70" : "text-muted-foreground"}`}
                          >
                            Shared deployment, Gateway adds caller identity
                          </span>
                        </button>
                      </div>
                    </TooltipTrigger>
                    {isTenancyLocked && (
                      <TooltipContent>
                        <p className="max-w-xs">
                          Tenancy cannot be changed after the server is created.
                          Delete and recreate the server to switch tenancy mode.
                        </p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </div>
              )}
            </div>

            {currentServerType === "local" && <Separator />}

            <div className="space-y-4">
              {currentServerType === "local" ? (
                <div className="space-y-1">
                  <h3 className="font-semibold text-base">Deployment</h3>
                  <p className="text-sm text-muted-foreground">
                    How {appName} runs this server in Kubernetes.
                  </p>
                </div>
              ) : null}

              {currentServerType === "remote" && (
                <FormField
                  control={form.control}
                  name="serverUrl"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Server URL <span className="text-destructive">*</span>
                        <ReinstallHint show={isServerUrlDirty} />
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder="https://api.example.com/mcp"
                          className="font-mono"
                          autoComplete={MCP_CONFIG_AUTOCOMPLETE}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {currentServerType === "local" && (
                <>
                  <FormField
                    control={form.control}
                    name="localConfig.command"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Command
                          <ReinstallHint show={isCommandDirty} />
                        </FormLabel>
                        <FormControl>
                          <Input
                            placeholder="node"
                            className="font-mono"
                            autoComplete={MCP_CONFIG_AUTOCOMPLETE}
                            {...field}
                          />
                        </FormControl>
                        <FormDescription>
                          The executable command to run. Optional if Docker
                          Image is set (will use image's default{" "}
                          <code>CMD</code>).
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="localConfig.arguments"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Arguments (one per line)
                          <ReinstallHint show={isArgumentsDirty} />
                        </FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder={`/path/to/server.js\n--verbose`}
                            className="font-mono min-h-20"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="localConfig.transportType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Transport Type
                          <ReinstallHint show={isTransportTypeDirty} />
                        </FormLabel>
                        <FormControl>
                          <RadioGroup
                            onValueChange={field.onChange}
                            value={field.value || "streamable-http"}
                            className="space-y-1"
                          >
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                                value="streamable-http"
                                id="transport-http"
                              />
                              <FormLabel
                                htmlFor="transport-http"
                                className="font-normal cursor-pointer"
                              >
                                Streamable HTTP (default)
                              </FormLabel>
                            </div>
                            <div className="flex items-center space-x-2">
                              <RadioGroupItem
                                value="stdio"
                                id="transport-stdio"
                              />
                              <FormLabel
                                htmlFor="transport-stdio"
                                className="font-normal cursor-pointer"
                              >
                                stdio
                              </FormLabel>
                            </div>
                          </RadioGroup>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {form.watch("localConfig.transportType") ===
                    "streamable-http" && (
                    <div className="grid gap-4 sm:grid-cols-2 rounded-lg border p-4">
                      <FormField
                        control={form.control}
                        name="localConfig.httpPort"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              HTTP Port (optional)
                              <ReinstallHint show={isHttpPortDirty} />
                            </FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                placeholder="8080"
                                className="font-mono"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="localConfig.httpPath"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              HTTP Path (optional)
                              <ReinstallHint show={isHttpPathDirty} />
                            </FormLabel>
                            <FormControl>
                              <Input
                                placeholder="/mcp"
                                className="font-mono"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  )}
                </>
              )}
            </div>

            {currentServerType === "local" && (
              <div className="space-y-4">
                <EnvironmentVariablesFormField
                  fields={fields}
                  append={append}
                  remove={remove}
                  fieldNamePrefix="localConfig.environment"
                  form={form}
                  validateValue={validateConfigValue}
                  useExternalSecretsManager={showByosOption}
                  secretKeysWithStoredValue={storedSecretKeys}
                  disablePromptOnInstallation={isMultitenant}
                  disablePromptOnInstallationReason="Multi-tenant servers share one deployment, so env vars are set once at deploy time and cannot be prompted per install."
                  labelSuffix={<ReinstallHint show={isEnvDirty} />}
                  envFrom={{
                    fields: envFromFields,
                    append: appendEnvFrom,
                    remove: removeEnvFrom,
                    watch: form.watch,
                    setValue: form.setValue,
                    register: form.register,
                    fieldNamePrefix: "localConfig.envFrom",
                  }}
                />
              </div>
            )}

            {currentServerType === "local" && (
              <div className="space-y-4">
                <h3 className="font-semibold text-base">Docker</h3>

                <FormField
                  control={form.control}
                  name="localConfig.dockerImage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Image (optional)
                        <ReinstallHint show={isDockerImageDirty} />
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder={mcpServerBaseImage}
                          className="font-mono"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-base">
                      Image Pull Secrets
                    </h3>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        appendImagePullSecret({ source: "existing", name: "" })
                      }
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </Button>
                  </div>

                  {imagePullSecretFields.length === 0 ? (
                    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      No image pull secrets configured.
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Kubernetes secrets for pulling container images from
                      private registries.{" "}
                      <ExternalDocsLink
                        href="https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/"
                        className="underline underline-offset-2 hover:text-primary/80"
                        showIcon={false}
                      >
                        Learn more
                      </ExternalDocsLink>
                    </p>
                  )}

                  {imagePullSecretFields.map((field, index) => {
                    const watchField = (key: string) =>
                      form.watch(
                        // biome-ignore lint/suspicious/noExplicitAny: discriminated union paths need cast
                        `localConfig.imagePullSecrets.${index}.${key}` as any,
                      ) ?? "";
                    const setField = (key: string, value: string) =>
                      form.setValue(
                        // biome-ignore lint/suspicious/noExplicitAny: discriminated union paths need cast
                        `localConfig.imagePullSecrets.${index}.${key}` as any,
                        value,
                      );
                    const source = watchField("source");

                    return (
                      <div
                        key={field.id}
                        className="border rounded-lg p-3 space-y-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <Select
                            value={source}
                            onValueChange={(val) => {
                              if (val === "existing") {
                                updateImagePullSecret(index, {
                                  source: "existing",
                                  name: "",
                                });
                              } else {
                                updateImagePullSecret(index, {
                                  source: "credentials",
                                  server: "",
                                  username: "",
                                  email: "",
                                });
                              }
                            }}
                          >
                            <SelectTrigger className="w-[200px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="existing">
                                Existing Secret
                              </SelectItem>
                              <SelectItem value="credentials">
                                Registry Credentials
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => removeImagePullSecret(index)}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
                          </Button>
                        </div>

                        {source === "existing" ? (
                          <SearchableSelect
                            value={watchField("name")}
                            onValueChange={(val) => setField("name", val)}
                            items={imagePullSecretItems}
                            placeholder="Select a secret..."
                            searchPlaceholder="Search secrets..."
                            allowCustom
                            multiline
                            className="w-full"
                            contentClassName="w-[min(var(--radix-popover-trigger-width),calc(100vw-2rem))]"
                            emptyMessage="No image pull secrets found."
                          />
                        ) : (
                          <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1">
                              <Label className="text-xs">Server</Label>
                              <Input
                                placeholder="e.g. quay.io"
                                className="font-mono"
                                autoComplete={MCP_CONFIG_AUTOCOMPLETE}
                                value={watchField("server")}
                                onChange={(e) =>
                                  setField("server", e.target.value)
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Username</Label>
                              <Input
                                placeholder="username"
                                autoComplete={MCP_CONFIG_AUTOCOMPLETE}
                                value={watchField("username")}
                                onChange={(e) =>
                                  setField("username", e.target.value)
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">Password</Label>
                              <SecretInput
                                placeholder={
                                  mode === "edit" && !watchField("password")
                                    ? "Saved — leave blank to keep"
                                    : "password"
                                }
                                value={watchField("password") ?? ""}
                                onChange={(e) =>
                                  setField("password", e.target.value)
                                }
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">
                                Email (optional)
                              </Label>
                              <Input
                                placeholder="email@example.com"
                                autoComplete={MCP_CONFIG_AUTOCOMPLETE}
                                value={watchField("email")}
                                onChange={(e) =>
                                  setField("email", e.target.value)
                                }
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {(currentServerType === "remote" ||
              (currentServerType === "local" && isMultitenant)) && (
              <Separator />
            )}
            {(currentServerType === "remote" ||
              (currentServerType === "local" && isMultitenant)) && (
              <div className="space-y-4">
                <div className="space-y-1">
                  <h3 className="font-semibold text-base">
                    Authentication
                    <ReinstallHint show={isAuthDirty} />
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    If your MCP server is multitenant, MCP Gateway will use
                    these ways to prove the caller&apos;s identity.
                    {mcpAuthDocsUrl ? (
                      <>
                        {" "}
                        <ExternalDocsLink
                          href={mcpAuthDocsUrl}
                          className="underline"
                          showIcon={false}
                        >
                          Learn more
                        </ExternalDocsLink>
                      </>
                    ) : null}
                  </p>
                </div>
                <FormField
                  control={form.control}
                  name="authMethod"
                  render={({ field }) => {
                    const authCards: Array<{
                      value: McpCatalogFormValues["authMethod"];
                      title: string;
                      description: string;
                      icon: ReactNode;
                      badge?: {
                        label: string;
                        variant?: "default" | "secondary";
                      };
                      customBadge?: ReactNode;
                      available: boolean;
                      disabledReason?: ReactNode | null;
                    }> = [
                      {
                        value: "none",
                        title: "None",
                        description:
                          currentServerType === "remote"
                            ? "No auth — server is public or single-tenant"
                            : "No auth — credentials passed via env vars",
                        icon: <Ban className="h-4 w-4" />,
                        available: true,
                      },
                      {
                        value: "auth_header",
                        title: "Token header",
                        description: "Prompt the user for a token at install",
                        icon: <KeyRound className="h-4 w-4" />,
                        badge: { label: "Common", variant: "secondary" },
                        available:
                          currentServerType === "remote" ||
                          (currentServerType === "local" &&
                            currentTransportType === "streamable-http"),
                      },
                      {
                        value: "oauth",
                        title: "OAuth 2.1",
                        description: "Auto-discovered from the server URL",
                        icon: <Sparkles className="h-4 w-4" />,
                        badge: { label: "Recommended" },
                        available:
                          currentServerType === "remote" ||
                          currentServerType === "local",
                      },
                      {
                        value: "oauth_client_credentials",
                        title: "OAuth 2.0 client credentials",
                        description: "Server-to-server, no user interaction",
                        icon: <Code className="h-4 w-4" />,
                        available: currentServerType === "remote",
                      },
                      {
                        value: "enterprise_managed",
                        title: "IdP token exchange",
                        description:
                          "Trade caller's IdP token for an upstream one",
                        icon: <IdCard className="h-4 w-4" />,
                        customBadge: enterpriseAuthDisabledBadge,
                        available: !enterpriseAuthDisabled,
                        disabledReason: enterpriseAuthDisabledReason,
                      },
                      {
                        value: "idp_jwt",
                        title: "IdP signed JWT",
                        description: "Sign a JWT with a configured IdP key",
                        icon: <IdCard className="h-4 w-4" />,
                        customBadge: enterpriseAuthDisabledBadge,
                        available: !enterpriseAuthDisabled,
                        disabledReason: enterpriseAuthDisabledReason,
                      },
                      {
                        value: "bearer",
                        title: "Access token header (legacy)",
                        description: "Legacy mode — kept for backwards compat",
                        icon: <KeyRound className="h-4 w-4" />,
                        available: authMethod === "bearer",
                      },
                    ];

                    const visibleCards = authCards.filter(
                      (card) =>
                        card.available ||
                        card.disabledReason != null ||
                        card.customBadge != null,
                    );

                    return (
                      <FormItem>
                        <FormControl>
                          <div className="space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              {visibleCards.map((card) => (
                                <AuthMethodCard
                                  key={card.value}
                                  title={card.title}
                                  description={card.description}
                                  icon={card.icon}
                                  badge={card.badge}
                                  customBadge={card.customBadge}
                                  selected={field.value === card.value}
                                  disabled={!card.available}
                                  disabledReason={card.disabledReason}
                                  onSelect={() =>
                                    handleAuthMethodChange(card.value)
                                  }
                                />
                              ))}
                            </div>

                            {authMethod === "oauth" && (
                              <div className="space-y-4 border rounded-lg p-5">
                                {currentServerType === "local" && (
                                  <FormField
                                    control={form.control}
                                    name="oauthConfig.oauthServerUrl"
                                    render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>
                                          OAuth Server URL{" "}
                                          <span className="text-destructive">
                                            *
                                          </span>
                                        </FormLabel>
                                        <FormControl>
                                          <Input
                                            placeholder="https://auth.example.com"
                                            className="font-mono"
                                            {...field}
                                          />
                                        </FormControl>
                                        <FormDescription>
                                          Base URL used for OAuth discovery. Use
                                          the issuer or auth server base URL
                                          here, not the token endpoint. This is
                                          separate from the K8s-deployed server.
                                        </FormDescription>
                                        <FormMessage />
                                      </FormItem>
                                    )}
                                  />
                                )}

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.authServerUrl"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>
                                        Authorization Server URL
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="https://auth.example.com"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Optional override for discovery when the
                                        MCP server URL is not the OAuth issuer.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.authorizationEndpoint"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>
                                        Authorization Endpoint
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="https://auth.example.com/oauth/authorize"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Optional direct authorization endpoint
                                        override. When set, it overrides
                                        discovery. Set together with Token
                                        Endpoint.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.wellKnownUrl"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>
                                        Well-Known Metadata URL
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="https://auth.example.com/.well-known/openid-configuration"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Optional direct metadata endpoint
                                        override when provider discovery is
                                        non-standard.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.tokenEndpoint"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>
                                        Token Endpoint{" "}
                                        <span className="text-destructive">
                                          *
                                        </span>
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="https://auth.example.com/oauth/token"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Optional direct token endpoint override.
                                        When set, it overrides discovery. Set
                                        together with Authorization Endpoint.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.client_id"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>Client ID</FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="your-client-id (optional for dynamic registration)"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Leave empty if the server supports
                                        dynamic client registration
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                {showByosOption ? (
                                  <div className="space-y-2">
                                    <Label>Client Secret</Label>
                                    <ExternalSecretSelector
                                      selectedTeamId={oauthVaultTeamId}
                                      selectedSecretPath={oauthVaultSecretPath}
                                      selectedSecretKey={oauthVaultSecretKey}
                                      onTeamChange={setOauthVaultTeamId}
                                      onSecretChange={setOauthVaultSecretPath}
                                      onSecretKeyChange={setOauthVaultSecretKey}
                                    />
                                  </div>
                                ) : (
                                  <FormField
                                    control={form.control}
                                    name="oauthConfig.client_secret"
                                    render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Client Secret</FormLabel>
                                        <FormControl>
                                          <SecretInput
                                            placeholder="your-client-secret (optional)"
                                            className="font-mono"
                                            {...field}
                                          />
                                        </FormControl>
                                        <FormMessage />
                                      </FormItem>
                                    )}
                                  />
                                )}

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.redirect_uris"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>
                                        MCP OAuth callback URIs{" "}
                                        <span className="text-destructive">
                                          *
                                        </span>
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="https://localhost:3000/oauth-callback, https://app.example.com/oauth-callback"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Use {appName}'s MCP install callback,
                                        usually{" "}
                                        <code>
                                          {typeof window !== "undefined"
                                            ? `${window.location.origin}/oauth-callback`
                                            : "https://app.example.com/oauth-callback"}
                                        </code>
                                        . Do not use the SSO callback URL under{" "}
                                        <code>/api/auth/sso/callback</code>.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.resource"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>Protected Resource</FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="https://api.example.com or api://client-id"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Optional OAuth resource/audience sent in
                                        the authorization request and token
                                        exchange. Leave blank to omit the OAuth
                                        resource parameter.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.scopes"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>Scopes</FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="read, write"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Comma-separated list of OAuth scopes.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.additional_scopes"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>Additional scopes</FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="offline_access"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Always appended on top of the requested
                                        scopes. offline_access is added by
                                        default so the provider returns a
                                        refresh token; clear it for providers
                                        that reject it (e.g. Google).
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.supports_resource_metadata"
                                  render={({ field }) => (
                                    <FormItem className="flex flex-row items-start space-x-2 space-y-0">
                                      <FormControl>
                                        <Checkbox
                                          checked={field.value}
                                          onCheckedChange={field.onChange}
                                          className="mt-1"
                                        />
                                      </FormControl>
                                      <div className="space-y-1 leading-none">
                                        <FormLabel className="font-normal cursor-pointer">
                                          Supports OAuth Resource Metadata
                                        </FormLabel>
                                        <FormDescription>
                                          Enable if the server publishes OAuth
                                          metadata at
                                          /.well-known/oauth-authorization-server
                                          for automatic endpoint discovery
                                        </FormDescription>
                                      </div>
                                    </FormItem>
                                  )}
                                />
                              </div>
                            )}
                            {authMethod === "bearer" && (
                              <div className="space-y-4 border rounded-lg p-5">
                                <div className="bg-muted p-4 rounded-lg">
                                  <p className="text-sm text-muted-foreground">
                                    Users will be prompted to provide their
                                    access token when installing this server.
                                  </p>
                                </div>

                                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                                  <FormField
                                    control={form.control}
                                    name="authHeaderName"
                                    render={({ field }) => (
                                      <FormItem>
                                        <FormLabel>Auth Header Name</FormLabel>
                                        <FormDescription className="text-xs">
                                          Defaults to <code>Authorization</code>
                                          . Set a custom header such as{" "}
                                          <code>x-api-key</code> when the
                                          upstream server expects the token
                                          outside the standard authorization
                                          header.
                                        </FormDescription>
                                        <FormControl>
                                          <Input
                                            placeholder="Authorization"
                                            autoComplete={
                                              MCP_CONFIG_AUTOCOMPLETE
                                            }
                                            {...field}
                                          />
                                        </FormControl>
                                        <FormMessage />
                                      </FormItem>
                                    )}
                                  />

                                  <FormField
                                    control={form.control}
                                    name="includeBearerPrefix"
                                    render={({ field }) => (
                                      <FormItem className="flex items-center gap-2 rounded-md border px-3 py-2 md:mb-0">
                                        <FormControl>
                                          <Checkbox
                                            checked={field.value}
                                            onCheckedChange={(checked) =>
                                              field.onChange(Boolean(checked))
                                            }
                                            id="include-bearer-prefix"
                                          />
                                        </FormControl>
                                        <FormLabel
                                          htmlFor="include-bearer-prefix"
                                          className="cursor-pointer font-normal"
                                        >
                                          Include Bearer Prefix
                                        </FormLabel>
                                      </FormItem>
                                    )}
                                  />
                                </div>
                              </div>
                            )}
                            {authMethod === "oauth_client_credentials" && (
                              <div className="space-y-4 border rounded-lg p-5">
                                <div className="bg-muted p-4 rounded-lg">
                                  <p className="text-sm text-muted-foreground">
                                    Installations will prompt for a shared
                                    client ID, client secret, and audience.{" "}
                                    {appName} will exchange them for a
                                    short-lived bearer token at runtime and
                                    refresh it automatically.
                                  </p>
                                </div>

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.authServerUrl"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>
                                        Authorization Server URL
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="https://auth.example.com"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Optional discovery base URL when the
                                        token endpoint is derived from an auth
                                        server instead of entered directly.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.wellKnownUrl"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>
                                        Well-Known Metadata URL
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="https://auth.example.com/.well-known/openid-configuration"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Optional direct metadata endpoint
                                        override when discovery is non-standard.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.tokenEndpoint"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>
                                        Token Endpoint{" "}
                                        <span className="text-destructive">
                                          *
                                        </span>
                                      </FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="https://auth.example.com/oauth/token"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Endpoint used to exchange the stored
                                        client credentials for a short-lived
                                        bearer token.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.audience"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>Default Audience</FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="https://api.example.com"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Optional default audience shown during
                                        installation. Teams can override it per
                                        shared connection.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />

                                <FormField
                                  control={form.control}
                                  name="oauthConfig.scopes"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormLabel>Scopes</FormLabel>
                                      <FormControl>
                                        <Input
                                          placeholder="read, write"
                                          className="font-mono"
                                          {...field}
                                        />
                                      </FormControl>
                                      <FormDescription>
                                        Optional comma-separated OAuth scopes to
                                        include in the client credentials token
                                        request.
                                      </FormDescription>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />
                              </div>
                            )}
                            {authMethod === "enterprise_managed" && (
                              <div className="space-y-4 border rounded-lg p-5">
                                <div className="bg-muted p-4 rounded-lg">
                                  <p className="text-sm text-muted-foreground">
                                    Exchange the signed-in user&apos;s
                                    identity-provider token for a downstream
                                    credential for this MCP server.{" "}
                                    <ExternalDocsLink
                                      href={mcpAuthTokenExchangeDocsUrl}
                                      className="inline-flex items-center gap-1 underline underline-offset-4"
                                    >
                                      Learn more
                                    </ExternalDocsLink>
                                  </p>
                                  <p className="mt-2 text-sm text-muted-foreground">
                                    {`${appName} will exchange that token at tool-call time. Use the fields below to choose what credential to request and how it should be sent to the upstream MCP server. Installations inherit these defaults automatically.`}
                                  </p>
                                </div>

                                <EnterpriseIdentityProviderField
                                  control={form.control}
                                  identityProviders={oidcIdentityProviders}
                                />

                                <FormField
                                  control={form.control}
                                  name="enterpriseManagedConfig"
                                  render={({ field }) => (
                                    <FormItem>
                                      <FormControl>
                                        <EnterpriseManagedCredentialFields
                                          value={
                                            (field.value as
                                              | EnterpriseManagedConfigInput
                                              | null
                                              | undefined) ?? null
                                          }
                                          onChange={field.onChange}
                                        />
                                      </FormControl>
                                      <FormMessage />
                                    </FormItem>
                                  )}
                                />
                              </div>
                            )}
                            {authMethod === "idp_jwt" && (
                              <div className="space-y-4 border rounded-lg p-5">
                                <div className="bg-muted p-4 rounded-lg">
                                  <p className="text-sm text-muted-foreground">
                                    {`${appName} will pass through the caller's IdP JWT to the upstream MCP server. In the current configuration this is sent as an Authorization: Bearer header. Use this when the upstream server validates the same JWT against the IdP's JWKS endpoint directly.`}{" "}
                                    <ExternalDocsLink
                                      href={mcpAuthJwksDocsUrl}
                                      className="inline-flex items-center gap-1 underline underline-offset-4"
                                    >
                                      Learn more
                                    </ExternalDocsLink>
                                  </p>
                                </div>

                                <EnterpriseIdentityProviderField
                                  control={form.control}
                                  identityProviders={oidcIdentityProviders}
                                />
                              </div>
                            )}
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />
              </div>
            )}

            {(currentServerType === "remote" ||
              (currentServerType === "local" &&
                currentTransportType === "streamable-http")) && <Separator />}
            {(currentServerType === "remote" ||
              (currentServerType === "local" &&
                currentTransportType === "streamable-http")) && (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <h3 className="font-semibold text-base">
                      Headers
                      <ReinstallHint show={isHeadersDirty} />
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Sent on every request — for tenant IDs, regions, or other
                      upstream metadata.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setHeaderDialog({ mode: "add" })}
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Header
                  </Button>
                </div>

                {additionalHeaderFields.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    No headers configured.
                  </div>
                ) : (
                  // TODO(e2e): tests under platform/e2e-tests previously drove
                  // the inline header inputs; after this refactor those
                  // interactions live in HeaderDialog (click "Add Header" /
                  // click a row first, then operate inside the modal).
                  <HeadersReadOnlyTable
                    form={form}
                    fields={additionalHeaderFields}
                    fieldNamePrefix="additionalHeaders"
                    onEdit={(index) => setHeaderDialog({ mode: "edit", index })}
                    onDelete={(index) => removeAdditionalHeader(index)}
                  />
                )}
                <HeaderDialog
                  open={headerDialog !== null}
                  mode={headerDialog?.mode === "edit" ? "edit" : "add"}
                  initial={
                    headerDialog?.mode === "edit"
                      ? readHeaderRowAsDraft(form, headerDialog.index)
                      : null
                  }
                  existingHeaderNames={readOtherHeaderNames(
                    form,
                    additionalHeaderFields.length,
                    headerDialog?.mode === "edit" ? headerDialog.index : null,
                  )}
                  validateValue={validateConfigValue}
                  onClose={() => setHeaderDialog(null)}
                  onConfirm={(draft) => {
                    if (headerDialog?.mode === "add") {
                      appendAdditionalHeader(headerDraftToRow(draft));
                    } else if (headerDialog?.mode === "edit") {
                      applyHeaderDraftToRow(form, headerDialog.index, draft);
                    }
                    setHeaderDialog(null);
                  }}
                />
              </div>
            )}

            <Separator />
            <div className={embedded ? "mb-4" : ""}>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-base">Labels</h3>
                  {labels.length > 0 && (
                    <span className="text-xs bg-muted px-1.5 py-0.5 rounded-full">
                      {labels.length}
                    </span>
                  )}
                </div>
              </div>
              <div className="pt-4">
                <ProfileLabels
                  ref={labelsRef}
                  labels={labels}
                  onLabelsChange={setLabels}
                  showLabel={false}
                />
              </div>
            </div>
          </div>
        </fieldset>

        {pendingSubmit !== null ? (
          <ReinstallConfirmBar
            // Mode was captured at submit-time by `computeCascadeOutcome`;
            // we honor that decision even if dirty state shifts while
            // the bar is up (e.g., user tweaks labels mid-confirm).
            mode={pendingSubmit.mode}
            isMultitenant={isMultitenant}
            affectedServerCount={affectedServerCount}
            isSubmitting={isConfirming}
            onCancel={() => setPendingSubmit(null)}
            onConfirm={async () => {
              // Keep `pendingSubmit` set during the await so the bar
              // stays visible (spinner + disabled buttons) until the
              // mutation completes.
              setIsConfirming(true);
              try {
                await performSubmit(pendingSubmit.values);
              } finally {
                setIsConfirming(false);
                setPendingSubmit(null);
              }
            }}
          />
        ) : typeof footer === "function" ? (
          footer({
            isDirty,
            onReset: () => {
              form.reset();
              setLabels(labelsBaseline);
            },
            hasBlockingErrors: hasEnvRuleViolations,
          })
        ) : (
          footer
        )}
      </form>
    </Form>
  );
}

/**
 * Recursively check whether a `react-hook-form` dirtyFields branch
 * actually has any dirty leaf. Necessary because RHF's dirty-tracking
 * for arrays allocates an entry per index with per-leaf booleans even
 * when nothing changed — so a `Boolean(dirtyFields.someArray)` check
 * misfires on every form that has any non-empty array (e.g.,
 * additionalHeaders, localConfig.environment).
 */
function isReallyDirty(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(isReallyDirty);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(isReallyDirty);
  }
  return Boolean(value);
}

function ReinstallHint({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <Badge variant="outline" className="ml-2 font-normal">
      requires reinstall
    </Badge>
  );
}

type PromptedEnvVarInfo = {
  required: boolean;
  type: string;
  mounted: boolean;
};

/**
 * Mirror of `promptedEnvVarsChanged` in
 * `backend/src/services/mcp-reinstall.ts`. Returns true only when an env
 * array change actually invalidates existing installs:
 *
 *   - Added OPTIONAL prompted var → existing installs stay valid (false)
 *   - Added REQUIRED prompted var → existing installs missing required → true
 *   - Removed prompted var        → stored value for removed var → true
 *   - Type change                 → storage moved (e.g. plain ↔ secret) → true
 *   - required false → true       → existing installs invalid → true
 *   - required true → false       → existing installs still valid → false
 *
 * For NON-prompted env vars (the catalog-template ones whose values ARE
 * part of the catalog), any change to value, key, type, or membership is
 * a real catalog-spec change that the pod needs to pick up → true.
 *
 * Keep the two implementations in sync — they're the user-visible warning
 * and the authoritative gate respectively. Mismatch is a silent UX bug.
 */
function envChangeRequiresReinstall(prev: unknown, next: unknown): boolean {
  const prevArr = Array.isArray(prev) ? (prev as RawEnvVar[]) : [];
  const nextArr = Array.isArray(next) ? (next as RawEnvVar[]) : [];

  // Non-prompted vars: catalog-template, full value comparison.
  const prevNonPrompted = nonPromptedSnapshot(prevArr);
  const nextNonPrompted = nonPromptedSnapshot(nextArr);
  if (JSON.stringify(prevNonPrompted) !== JSON.stringify(nextNonPrompted)) {
    return true;
  }

  // Prompted vars: schema-evolution rules (see comment above).
  const prevMap = promptedMap(prevArr);
  const nextMap = promptedMap(nextArr);
  for (const [key, prevVal] of prevMap) {
    const nextVal = nextMap.get(key);
    if (!nextVal) return true;
    if (nextVal.type !== prevVal.type) return true;
    if (!prevVal.required && nextVal.required) return true;
    // Runtime layout change: `mounted` flips the pod spec between env
    // var injection and a mounted secret file at `/secrets/<key>`.
    // Mirror of backend `promptedEnvVarsRuntimeChanged` — without
    // this, the badge stays hidden while the cascade bar still
    // fires on save.
    if (prevVal.mounted !== nextVal.mounted) return true;
  }
  for (const [key, nextVal] of nextMap) {
    if (prevMap.has(key)) continue;
    if (nextVal.required) return true;
  }
  return false;
}

type RawEnvVar = {
  key?: string;
  type?: string;
  value?: unknown;
  required?: boolean;
  promptOnInstallation?: boolean;
  sensitive?: boolean;
  mounted?: boolean;
};

function promptedMap(arr: RawEnvVar[]): Map<string, PromptedEnvVarInfo> {
  const m = new Map<string, PromptedEnvVarInfo>();
  for (const v of arr) {
    if (!v?.key || !v.promptOnInstallation) continue;
    m.set(v.key, {
      required: Boolean(v.required),
      type: String(v.type ?? ""),
      mounted: Boolean(v.mounted),
    });
  }
  return m;
}

function nonPromptedSnapshot(arr: RawEnvVar[]): RawEnvVar[] {
  // Sorted by key so a reorder isn't read as a change.
  return arr
    .filter((v) => v && !v.promptOnInstallation && v.key)
    .map((v) => ({
      key: v.key,
      type: v.type,
      value: v.value,
      required: Boolean(v.required),
      sensitive: Boolean(v.sensitive),
    }))
    .sort((a, b) => (a.key ?? "").localeCompare(b.key ?? ""));
}

type AdditionalHeader = {
  fieldName?: string;
  headerName?: string;
  required?: boolean;
  sensitive?: boolean;
  value?: unknown;
  description?: string;
  includeBearerPrefix?: boolean;
  promptOnInstallation?: boolean;
};

/**
 * Reconstruct the form's `additionalHeaders` shape from a catalog's
 * `userConfig`. Mirrors the equivalent transform in
 * `mcp-catalog-form.utils.ts → transformCatalogItemToFormValues`. Used
 * to produce a stable baseline for `additionalHeadersChangeRequiresReinstall`.
 */
function deriveAdditionalHeaders(userConfig: unknown): AdditionalHeader[] {
  if (!userConfig || typeof userConfig !== "object") return [];
  const out: AdditionalHeader[] = [];
  for (const [fieldName, raw] of Object.entries(
    userConfig as Record<string, unknown>,
  )) {
    if (fieldName === "access_token" || fieldName === "raw_access_token") {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const cfg = raw as Record<string, unknown>;
    if (typeof cfg.headerName !== "string") continue;
    out.push({
      fieldName,
      headerName: cfg.headerName,
      required: Boolean(cfg.required),
      sensitive: Boolean(cfg.sensitive),
      value: typeof cfg.default === "string" ? cfg.default : undefined,
      description: typeof cfg.description === "string" ? cfg.description : "",
      includeBearerPrefix: cfg.valuePrefix === "Bearer ",
      promptOnInstallation:
        cfg.promptOnInstallation === undefined
          ? true
          : Boolean(cfg.promptOnInstallation),
    });
  }
  return out;
}

/**
 * Mirror of backend `userConfigChangedBreakingly`, scoped to header-
 * mapped userConfig fields (the form's `additionalHeaders` projection).
 * Returns true only when the change invalidates existing installs:
 *
 *   - Added OPTIONAL header  → existing installs stay valid (false)
 *   - Added REQUIRED header  → existing installs are missing it → true
 *   - Removed header         → stored value for removed field → true
 *   - required false → true  → installs that didn't fill it → true
 *   - required true → false  → installs still valid → false
 *   - headerName change      → routing changes → true
 *   - sensitive flag flip    → storage bucket moved → true
 *   - STATIC header `value`  → that's the actual runtime header sent on
 *     the wire (form writes it into `userConfig[field].default` when
 *     promptOnInstallation is false). Change there → installs would
 *     keep sending the old value → true
 *
 * Deliberately ignored:
 *   - `value` on prompted headers (becomes `default` in userConfig) —
 *     just a placeholder shown at install time, doesn't affect what's
 *     actually sent
 *   - `includeBearerPrefix` (becomes `valuePrefix: "Bearer "`) — cosmetic
 *     wire-format detail; doesn't move storage
 *   - `description`, `title` — pure metadata
 *
 * Keep in sync with `backend/src/services/mcp-reinstall.ts` — a
 * mismatch silently disagrees with the cascade bar's behaviour and
 * shows the user a misleading per-field hint badge.
 */
function additionalHeadersChangeRequiresReinstall(
  prev: AdditionalHeader[],
  next: unknown,
): boolean {
  const nextArr = Array.isArray(next) ? (next as AdditionalHeader[]) : [];
  const prevMap = new Map(
    prev.filter((h) => h.fieldName).map((h) => [h.fieldName as string, h]),
  );
  const nextMap = new Map(
    nextArr.filter((h) => h.fieldName).map((h) => [h.fieldName as string, h]),
  );
  for (const [key, p] of prevMap) {
    const n = nextMap.get(key);
    if (!n) return true; // Removed
    if (!p.required && Boolean(n.required)) return true; // Became required
    if ((p.headerName ?? "") !== (n.headerName ?? "")) return true; // Routing
    if (Boolean(p.sensitive) !== Boolean(n.sensitive)) return true; // Storage
    // Static header value rotation. `value` only matters at runtime
    // when the header is fully static (no install prompt) — for prompted
    // headers it's just a placeholder.
    const wasStatic = !p.promptOnInstallation;
    const isStatic = !n.promptOnInstallation;
    if (wasStatic && isStatic && (p.value ?? "") !== (n.value ?? "")) {
      return true;
    }
  }
  for (const [key, n] of nextMap) {
    if (prevMap.has(key)) continue;
    if (n.required) return true; // Added required
  }
  return false;
}

function EnterpriseIdentityProviderField(params: {
  control: ReturnType<typeof useForm<McpCatalogFormValues>>["control"];
  identityProviders: Array<{
    id: string;
    providerId: string;
    issuer: string;
  }>;
}) {
  return (
    <FormField
      control={params.control}
      name="enterpriseManagedConfig.identityProviderId"
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            Identity Provider <span className="text-destructive">*</span>
          </FormLabel>
          <FormDescription>
            Choose the same identity provider the MCP Gateway uses for this
            caller. This is required when the tool uses Resolve at call time or
            Identity Provider Token Exchange.
          </FormDescription>
          <Select value={field.value ?? ""} onValueChange={field.onChange}>
            <FormControl>
              <SelectTrigger>
                <SelectValue placeholder="Select an OIDC identity provider" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {params.identityProviders.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.providerId} ({provider.issuer})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function AuthMethodCard(params: {
  title: string;
  description: string;
  icon: ReactNode;
  badge?: { label: string; variant?: "default" | "secondary" };
  customBadge?: ReactNode;
  selected: boolean;
  disabled?: boolean;
  disabledReason?: ReactNode | null;
  onSelect: () => void;
}) {
  const isDisabled = Boolean(params.disabled);
  return (
    <button
      type="button"
      aria-pressed={params.selected}
      aria-disabled={isDisabled}
      onClick={isDisabled ? undefined : params.onSelect}
      className={[
        "w-full text-left rounded-lg border p-4 transition-colors",
        params.selected
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-foreground/30",
        isDisabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      ].join(" ")}
    >
      <div className="flex items-start gap-3">
        <div
          className={[
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            params.selected
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground",
          ].join(" ")}
        >
          {params.icon}
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-sm">{params.title}</span>
            {params.customBadge ??
              (params.badge && (
                <Badge
                  variant={params.badge.variant ?? "default"}
                  className="text-[10px] tracking-wide"
                >
                  {params.badge.label}
                </Badge>
              ))}
          </div>
          <p className="text-xs text-muted-foreground">{params.description}</p>
          {isDisabled && params.disabledReason ? (
            <div className="text-xs text-muted-foreground">
              {params.disabledReason}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function readHeaderRowAsDraft(
  form: UseFormReturn<McpCatalogFormValues>,
  index: number,
): HeaderDraft {
  const row = form.getValues(`additionalHeaders.${index}`);
  const promptOnInstallation = Boolean(row?.promptOnInstallation);
  return {
    headerName: row?.headerName ?? "",
    scope: promptOnInstallation ? "installation" : "static",
    required: Boolean(row?.required),
    value: row?.value ?? "",
    description: row?.description ?? "",
    includeBearerPrefix: Boolean(row?.includeBearerPrefix),
    sensitive: Boolean(row?.sensitive),
  };
}

function readOtherHeaderNames(
  form: UseFormReturn<McpCatalogFormValues>,
  length: number,
  excludeIndex: number | null,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    if (i === excludeIndex) continue;
    const name = form.getValues(`additionalHeaders.${i}.headerName`);
    if (name?.trim()) out.push(name.trim());
  }
  return out;
}

function headerDraftToRow(draft: HeaderDraft) {
  return {
    fieldName: undefined,
    headerName: draft.headerName,
    promptOnInstallation: draft.scope === "installation",
    required: draft.scope === "installation" ? draft.required : false,
    value: draft.scope === "static" ? draft.value : "",
    description: draft.description,
    includeBearerPrefix: draft.includeBearerPrefix,
    // Static fields can't be sensitive (server rejects the combination);
    // force false even if the draft somehow carries it (defense in depth).
    sensitive: draft.scope === "static" ? false : draft.sensitive,
  };
}

function applyHeaderDraftToRow(
  form: UseFormReturn<McpCatalogFormValues>,
  index: number,
  draft: HeaderDraft,
) {
  const set = (name: string, value: unknown) =>
    form.setValue(
      // biome-ignore lint/suspicious/noExplicitAny: dynamic field path
      `additionalHeaders.${index}.${name}` as any,
      value,
      { shouldDirty: true },
    );
  set("headerName", draft.headerName);
  set("promptOnInstallation", draft.scope === "installation");
  set("required", draft.scope === "installation" ? draft.required : false);
  set("value", draft.scope === "static" ? draft.value : "");
  set("description", draft.description);
  set("includeBearerPrefix", draft.includeBearerPrefix);
  set("sensitive", draft.scope === "static" ? false : draft.sensitive);
}

function formatRegistryServers(registryServers: string[]): string {
  if (registryServers.length === 0) {
    return "";
  }

  const [firstRegistry, ...remainingRegistries] = registryServers;
  if (remainingRegistries.length === 0) {
    return firstRegistry;
  }

  return `${firstRegistry} +${remainingRegistries.length} more`;
}
