"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type EnterpriseManagedConfigInput = {
  resourceIdentifier?: string;
  requestedIssuer?: string;
  requestedCredentialType?:
    | "bearer_token"
    | "id_jag"
    | "secret"
    | "service_account"
    | "opaque_json";
  tokenInjectionMode?:
    | "authorization_bearer"
    | "raw_authorization"
    | "header"
    | "env"
    | "body_field";
  headerName?: string;
  responseFieldPath?: string;
};

interface EnterpriseManagedCredentialFieldsProps {
  value: EnterpriseManagedConfigInput | null | undefined;
  onChange: (value: EnterpriseManagedConfigInput) => void;
}

const DEFAULT_CONFIG: EnterpriseManagedConfigInput = {
  requestedCredentialType: "secret",
  tokenInjectionMode: "authorization_bearer",
};

export function EnterpriseManagedCredentialFields({
  value,
  onChange,
}: EnterpriseManagedCredentialFieldsProps) {
  const config = value ?? DEFAULT_CONFIG;

  return (
    <div className="space-y-3 rounded-md border border-dashed p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Requested Credential</Label>
          <Select
            value={config.requestedCredentialType ?? "secret"}
            onValueChange={(requestedCredentialType) =>
              onChange({
                ...config,
                requestedCredentialType:
                  requestedCredentialType as EnterpriseManagedConfigInput["requestedCredentialType"],
              })
            }
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="secret">Secret</SelectItem>
              <SelectItem value="bearer_token">Bearer token</SelectItem>
              <SelectItem value="id_jag">ID-JAG</SelectItem>
              <SelectItem value="service_account">Service account</SelectItem>
              <SelectItem value="opaque_json">Opaque JSON</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Injection Mode</Label>
          <Select
            value={config.tokenInjectionMode ?? "authorization_bearer"}
            onValueChange={(tokenInjectionMode) =>
              onChange({
                ...config,
                tokenInjectionMode:
                  tokenInjectionMode as EnterpriseManagedConfigInput["tokenInjectionMode"],
              })
            }
          >
            <SelectTrigger size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="authorization_bearer">
                Authorization: Bearer
              </SelectItem>
              <SelectItem value="raw_authorization">
                Raw Authorization
              </SelectItem>
              <SelectItem value="header">Custom header</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Managed Resource Identifier</Label>
        <Input
          value={config.resourceIdentifier ?? ""}
          onChange={(event) =>
            onChange({
              ...config,
              resourceIdentifier: event.target.value || undefined,
            })
          }
          placeholder="Audience, resource ID, or other provider-specific identifier"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">External Provider Alias</Label>
        <Input
          value={config.requestedIssuer ?? ""}
          onChange={(event) =>
            onChange({
              ...config,
              requestedIssuer: event.target.value || undefined,
            })
          }
          placeholder="github"
        />
        <p className="text-[11px] text-muted-foreground">
          Optional. Use this when the identity provider brokers a token from an
          external provider, for example a Keycloak identity provider alias such
          as <code>github</code>.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Response Field Path</Label>
        <Input
          value={config.responseFieldPath ?? ""}
          onChange={(event) =>
            onChange({
              ...config,
              responseFieldPath: event.target.value || undefined,
            })
          }
          placeholder="token"
        />
        <p className="text-[11px] text-muted-foreground">
          Required when the provider returns a structured secret and Archestra
          needs to extract one field, for example <code>token</code>.
        </p>
      </div>

      {config.tokenInjectionMode === "header" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Header Name</Label>
          <Input
            value={config.headerName ?? ""}
            onChange={(event) =>
              onChange({
                ...config,
                headerName: event.target.value || undefined,
              })
            }
            placeholder="X-Provider-Token"
          />
        </div>
      )}
    </div>
  );
}
