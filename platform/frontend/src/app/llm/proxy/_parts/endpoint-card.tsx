"use client";

import { LLM_PROXY_OAUTH_SCOPE } from "@archestra/shared";
import { KeyRound, Plus, ShieldCheck, Waypoints } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import {
  getProxyEndpointProviders,
  type ProxyEndpointProvider,
} from "@/app/connection/connection-flow.utils";
import { OauthTokenRequest } from "@/components/connect-rail";
import { IdentityProviderSelect } from "@/components/identity-provider-select";
import { LlmConnectionDialogs } from "@/components/llm-connect-steps";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type LlmAuthMethod,
  type LlmConnection,
  useLlmConnection,
} from "@/components/use-llm-connection";
import { RequestExample } from "@/components/virtual-key-connection-guide";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useLlmProxy, useUpdateLlmProxy } from "@/lib/llm-proxy.query";
import { useOrganization } from "@/lib/organization.query";
import { DashboardCard, ProviderLogo } from "./dashboard-card";

type Target = "model-router" | ProxyEndpointProvider;

const AUTH_OPTIONS: Array<{ value: LlmAuthMethod; label: string }> = [
  { value: "standard", label: "Virtual key" },
  { value: "passthrough", label: "Passthrough" },
  { value: "oauth", label: "OAuth client" },
  { value: "idp", label: "Identity provider" },
];

const CREATE_VALUE = "__create__";
const NONE_VALUE = "__none__";

/** Build the request for the selected auth method, even on an empty org. */
export function EndpointCard({ baseUrl }: { baseUrl: string }) {
  const [selected, setSelected] = useState<Target>("model-router");
  const [auth, setAuth] = useState<LlmAuthMethod>("standard");

  return (
    <DashboardCard id="llm-proxy-endpoint" title="Endpoint">
      <EndpointRequest
        // A credential belongs to one format and auth method; start over
        // when either changes.
        key={`${selected}:${auth}`}
        baseUrl={baseUrl}
        selected={selected}
        auth={auth}
        onSelectedChange={(next) => {
          setSelected(next);
          if (next === "model-router" && usesNativeFormat(auth)) {
            setAuth("standard");
          }
        }}
        onAuthChange={(next, fallbackProvider) => {
          setAuth(next);
          if (usesNativeFormat(next) && selected === "model-router") {
            setSelected(fallbackProvider);
          }
        }}
      />
    </DashboardCard>
  );
}

function usesNativeFormat(auth: LlmAuthMethod) {
  return auth === "passthrough" || auth === "idp";
}

function EndpointRequest({
  baseUrl,
  selected,
  auth,
  onSelectedChange,
  onAuthChange,
}: {
  baseUrl: string;
  selected: Target;
  auth: LlmAuthMethod;
  onSelectedChange: (next: Target) => void;
  onAuthChange: (next: LlmAuthMethod, fallback: ProxyEndpointProvider) => void;
}) {
  const providerCatalog = useModelProviderCatalog({ fresh: true });
  const { data: organization } = useOrganization();
  const { data: providerKeys = [] } = useLlmProviderApiKeys();
  const connection = useLlmConnection({ selected, auth, offerAutoModel: true });
  const ids = { format: useId(), auth: useId(), credential: useId() };

  // Providers with a key lead, as clients can reach them.
  const allProviders = getProxyEndpointProviders(organization);
  const hasKey = (provider: ProxyEndpointProvider) =>
    providerKeys.some((key) => key.provider === provider);
  const providers = [
    ...allProviders.filter(hasKey),
    ...allProviders.filter((provider) => !hasKey(provider)),
  ];
  const fallbackProvider = providers[0] ?? "openai";
  const targetLabel =
    selected === "model-router"
      ? "Unified Model API"
      : providerCatalog.label(selected);

  const fields = (
    <>
      <Field id={ids.format} label="Format">
        <SearchableSelect
          id={ids.format}
          ariaLabel="API format"
          value={selected}
          onValueChange={(value) => onSelectedChange(value as Target)}
          searchPlaceholder="Search formats..."
          emptyMessage="No formats found."
          className="w-full"
          items={[
            {
              value: "model-router",
              label: "Unified Model API (OpenAI compatible)",
              content: (
                <span className="flex min-w-0 items-center gap-2">
                  <Waypoints className="size-[15px] shrink-0" />
                  <span className="truncate">
                    Unified Model API (OpenAI compatible)
                  </span>
                </span>
              ),
            },
            ...providers.map((provider) => ({
              value: provider,
              label: providerCatalog.label(provider),
              content: (
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderLogo provider={provider} />
                  <span className="truncate">
                    {providerCatalog.label(provider)}
                  </span>
                </span>
              ),
            })),
          ]}
        />
      </Field>
      <Field id={ids.auth} label="Authentication">
        <Select
          value={auth}
          onValueChange={(value) =>
            onAuthChange(value as LlmAuthMethod, fallbackProvider)
          }
        >
          <SelectTrigger
            id={ids.auth}
            className="w-full justify-start [&>svg:last-child]:ml-auto"
          >
            <ShieldCheck />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTH_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <CredentialField
        id={ids.credential}
        auth={auth}
        connection={connection}
      />
    </>
  );

  return (
    <div className="space-y-3">
      {connection.ready ? (
        <RequestExample
          key={connection.requestKey}
          connectionBaseUrl={baseUrl}
          {...connection.requestProps}
          fields={fields}
        />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))]">
            {fields}
            <Field id={`${ids.credential}-model`} label="Model">
              <Select disabled>
                <SelectTrigger
                  id={`${ids.credential}-model`}
                  className="w-full"
                >
                  <SelectValue placeholder="Pick a credential first" />
                </SelectTrigger>
              </Select>
            </Field>
          </div>
          {!connection.createdWithoutEndpointAccess && (
            <NotReadyHint
              auth={auth}
              connection={connection}
              targetLabel={targetLabel}
            />
          )}
        </>
      )}
      {connection.createdWithoutEndpointAccess && (
        <output className="block text-[12.5px] text-muted-foreground">
          <strong>{connection.createdWithoutEndpointAccess}</strong> was
          created, but it can’t call this endpoint yet. Add access in{" "}
          <Link
            href="/llm/proxy/virtual-keys"
            className="text-primary underline underline-offset-2"
          >
            Virtual keys
          </Link>
          .
        </output>
      )}
      {connection.ready && auth === "oauth" && connection.picked?.oauth && (
        <div className="space-y-2">
          <p className="text-[12.5px] text-muted-foreground">
            <code className="font-mono text-xs">
              $ARCHESTRA_LLM_ACCESS_TOKEN
            </code>{" "}
            is the <code className="font-mono text-xs">access_token</code> this
            request returns:
          </p>
          <OauthTokenRequest
            {...connection.picked.oauth}
            scope={LLM_PROXY_OAUTH_SCOPE}
          />
        </div>
      )}
      <LlmConnectionDialogs
        connection={connection}
        selected={selected}
        targetLabel={targetLabel}
      />
    </div>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-[12.5px]">
        {label}
      </Label>
      {children}
    </div>
  );
}

/**
 * The credential the request carries, for the chosen auth method: a virtual
 * or passthrough key, or an OAuth client, each with "Create new" opening its
 * dialog here; or the identity provider the proxy trusts, set up in settings.
 */
function CredentialField({
  id,
  auth,
  connection,
}: {
  id: string;
  auth: LlmAuthMethod;
  connection: LlmConnection;
}) {
  if (auth === "idp") return <IdentityProviderField id={id} />;

  const isOauth = auth === "oauth";
  const label = isOauth
    ? "OAuth client"
    : auth === "passthrough"
      ? "Passthrough key"
      : "Virtual key";
  const canCreate = isOauth
    ? connection.canCreateOauth
    : auth === "standard" && connection.canCreateKey;
  const allowNone = auth === "passthrough" && connection.allowsUnauthenticated;
  const { options, picked } = connection;
  const groups: Array<{ heading: string; items: typeof options }> = [];
  for (const option of options) {
    const last = groups.at(-1);
    if (last && last.heading === option.group) last.items.push(option);
    else groups.push({ heading: option.group, items: [option] });
  }

  return (
    <Field id={id} label={label}>
      <Select
        value={picked?.id ?? (allowNone ? NONE_VALUE : "")}
        onValueChange={(value) => {
          if (value === CREATE_VALUE) {
            if (isOauth) connection.setOauthCreateOpen(true);
            else if (auth === "standard")
              connection.setCreateKeyType("standard");
            return;
          }
          connection.pickKey(value === NONE_VALUE ? null : value);
        }}
      >
        <SelectTrigger
          id={id}
          className="w-full justify-start [&>svg:last-child]:ml-auto"
        >
          <KeyRound />
          <SelectValue
            placeholder={
              options.length === 0 ? `No ${label.toLowerCase()} yet` : label
            }
          />
        </SelectTrigger>
        <SelectContent>
          {allowNone && (
            <SelectItem value={NONE_VALUE}>No passthrough key</SelectItem>
          )}
          {groups.map((group) => (
            <SelectGroup key={group.heading}>
              {groups.length > 1 && <SelectLabel>{group.heading}</SelectLabel>}
              {group.items.map((option) => (
                <SelectItem
                  key={option.id}
                  value={option.id}
                  description={option.description}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
          {canCreate && (
            <>
              {(options.length > 0 || allowNone) && <SelectSeparator />}
              <SelectItem value={CREATE_VALUE} icon={<Plus />}>
                Create new {label.toLowerCase()}
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * The identity provider whose JWTs the proxy trusts. Choosing one changes the
 * proxy's setting; with none in the organization, setup is in settings, as its
 * create dialog starts from a provider type.
 */
function IdentityProviderField({ id }: { id: string }) {
  const { data: proxy } = useLlmProxy();
  const { data: canRead } = useHasPermissions({ identityProvider: ["read"] });
  const { data: identityProviders = [] } = useIdentityProviders({
    enabled: canRead === true,
  });
  const { data: canUpdate } = useHasPermissions({ llmProxy: ["update"] });
  const updateProxy = useUpdateLlmProxy();
  const issuer = identityProviders.find(
    (provider) => provider.id === proxy?.identityProviderId,
  )?.issuer;
  return (
    <Field id={id} label="Identity provider">
      {identityProviders.length > 0 && canUpdate ? (
        <IdentityProviderSelect
          id={id}
          identityProviders={identityProviders}
          value={proxy?.identityProviderId ?? null}
          disabled={updateProxy.isPending}
          onChange={(next) => updateProxy.mutate({ identityProviderId: next })}
          noneLabel="No identity provider"
          className="w-full"
        />
      ) : proxy?.identityProviderId ? (
        <div id={id} className="break-all text-sm">
          {issuer ? `Trusting ${issuer}` : "Identity provider configured"}
        </div>
      ) : canUpdate ? (
        <Button asChild variant="outline" className="w-full">
          <Link id={id} href="/settings/identity-providers">
            Set up identity provider
          </Link>
        </Button>
      ) : (
        <div id={id} className="text-sm text-muted-foreground">
          No identity provider configured.
        </div>
      )}
    </Field>
  );
}

/** Why there is no request yet, with the one action that brings it. */
function NotReadyHint({
  auth,
  connection,
  targetLabel,
}: {
  auth: LlmAuthMethod;
  connection: LlmConnection;
  targetLabel: string;
}) {
  const { data: canAddKey } = useHasPermissions({
    llmProviderApiKey: ["create"],
  });
  const providerNoun = connection.isRouter ? "provider" : targetLabel;
  if (auth !== "passthrough" && connection.providerKeysPending) {
    return null;
  }
  if (!connection.hasProviderKey && auth !== "passthrough") {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        No {providerNoun} key yet. The proxy needs one to call the provider.{" "}
        {canAddKey && (
          <Button
            variant="link"
            size="xs"
            className="h-auto px-0"
            onClick={() => connection.setAddProviderKeyOpen(true)}
          >
            Add {providerNoun} key
          </Button>
        )}
      </p>
    );
  }
  if (auth === "passthrough") {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        Choose a passthrough key, or{" "}
        <Link
          href="/llm/proxy/virtual-keys?keyType=passthrough"
          className="text-primary underline underline-offset-2"
        >
          manage passthrough keys
        </Link>
        .
      </p>
    );
  }
  return (
    <p className="text-[12.5px] text-muted-foreground">
      {auth === "idp"
        ? "Choose the identity provider the proxy trusts to see the request."
        : auth === "oauth"
          ? "Choose or create an OAuth client to see the request."
          : "Choose or create a key to see the request."}
    </p>
  );
}
