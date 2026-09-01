"use client";

import { DocsPage } from "@archestra/shared";
import { Download } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import { CopyButton } from "@/components/copy-button";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Button } from "@/components/ui/button";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useMfilesVafAddOnDistribution } from "@/lib/knowledge/connector.query";

// biome-ignore lint/suspicious/noExplicitAny: form type is generic across connector schemas
type ConnectorForm = UseFormReturn<any>;

function usesOAuth(form: ConnectorForm): boolean {
  // Absent means the legacy password-token mode — the same default the
  // backend applies, so a config created via the API renders truthfully.
  return (
    ((form.watch("config.authMethod") as string | undefined) ??
      "mfiles_password_token") === "oauth_client_credentials"
  );
}

/**
 * Main-form fields, ordered by the connection workflow: the vault-side
 * add-on prerequisite first, then the Vault GUID right next to it (the
 * install command ends by printing it), then the web service URL, then
 * authentication. The URL field lives here rather than in the dialogs'
 * shared slot so the add-on section can precede it. The authentication
 * method decides which credential fields follow, so it must sit here — a
 * collapsed Advanced section must never hide a field that can fail
 * validation.
 */
export function MFilesInlineFields({
  form,
  mode,
}: {
  form: ConnectorForm;
  mode: "create" | "edit";
}) {
  const oauth = usesOAuth(form);
  // The Application Account method is gated separately and off by default.
  // The selector renders only when there is a choice to make: the flag is
  // on, or the connector being edited already uses OAuth (render truthfully).
  const oauthAllowed = useFeature("kbMfilesOauthEnabled") ?? false;
  const showAuthMethod = oauthAllowed || oauth;
  return (
    <>
      <MFilesVafAddOnSection />
      <TextField
        form={form}
        name="config.vaultGuid"
        label="Vault GUID"
        placeholder="{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}"
        description="The VAF Add On install command prints it in the end. Or copy it from the vault's properties in M-Files Admin."
        required="Vault GUID is required"
      />
      <TextField
        form={form}
        name="config.baseUrl"
        label="M-Files Web Service URL"
        placeholder="https://your-mfiles-server/m-files"
        description="Where classic M-Files Web opens in the browser; cloud vaults use https://yourvault.cloudvault.m-files.com. The connector appends /REST automatically."
        required="M-Files Web Service URL is required"
      />
      {showAuthMethod ? (
        <FormField
          control={form.control}
          name="config.authMethod"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Authentication Method</FormLabel>
              <FormDescription>
                Application Accounts sign in through your identity provider
                without a stored vault password.
              </FormDescription>
              <Select
                value={
                  (field.value as string | undefined) ?? "mfiles_password_token"
                }
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="mfiles_password_token">
                    Login Account
                  </SelectItem>
                  <SelectItem value="oauth_client_credentials">
                    Application Account
                  </SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      ) : null}
      {oauth ? (
        <>
          <TextField
            form={form}
            name="config.oauthTokenEndpoint"
            label="OAuth Token Endpoint"
            placeholder="https://login.microsoftonline.com/your-tenant-id/oauth2/v2.0/token"
            description="Client-credentials token endpoint of the identity provider configured in M-Files."
            required="OAuth token endpoint is required"
          />
          <TextField
            form={form}
            name="config.oauthAuthConfig"
            label="Authentication Configuration Name"
            placeholder="Technical Credentials"
            description="Provider name exactly as configured for the vault (sent as X-AuthConfig)."
            required="Authentication configuration name is required"
          />
          <TextField
            form={form}
            name="config.oauthAuthConfigScope"
            label="Authentication Configuration Scope"
            placeholder="technical"
            description="Scope containing the provider (sent as X-AuthConfigScope). The required trailing colon is added automatically."
            required="Authentication configuration scope is required"
          />
          <TextField
            form={form}
            name="config.oauthAccountName"
            label="Application Account Username"
            placeholder={String.raw`integration\archestra`}
            description="Username of the M-Files Application Account selected for this connector."
            required="Application account username is required"
          />
          <TextField
            form={form}
            name="config.oauthScope"
            label="Token Audience"
            placeholder="api://your-mfiles-app/.default"
            description="Your provider's identifier for M-Files, from its app registration — Entra ID uses api://…/.default. Some providers don't need one."
          />
        </>
      ) : null}
      <FormField
        control={form.control}
        name="email"
        rules={
          mode === "create"
            ? {
                required: oauth
                  ? "Client ID is required"
                  : "Username is required",
              }
            : undefined
        }
        render={({ field }) => (
          <FormItem>
            <FormLabel>{oauth ? "Client ID" : "Username"}</FormLabel>
            <FormDescription>
              {oauth ? (
                <span>Client ID of the M-Files Application Account.</span>
              ) : (
                <span>Dedicated M-Files login account for the connector.</span>
              )}
            </FormDescription>
            <FormControl>
              <Input
                placeholder={
                  mode === "create"
                    ? oauth
                      ? "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      : "svc-archestra"
                    : "Leave empty to keep existing credentials"
                }
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}

/** Advanced section: optional tuning only — nothing here is required. */
export function MFilesConfigFields({ form }: { form: ConnectorForm }) {
  const oauth = usesOAuth(form);
  return (
    // space-y-4 matches the 16px rhythm of the shared dialog fields.
    <div className="space-y-4">
      {oauth ? (
        <FormField
          control={form.control}
          name="config.oauthUseIdToken"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel>Use ID Token as Bearer Token</FormLabel>
                <FormDescription>
                  Only when the M-Files provider setting is
                  <code className="ml-1">UseIdTokenAsAccessToken</code>.
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={Boolean(field.value)}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />
      ) : (
        <TextField
          form={form}
          name="config.domain"
          label="Windows Domain (optional)"
          placeholder="CONTOSO"
          description="Only for domain-authenticated M-Files login accounts."
        />
      )}
    </div>
  );
}

/**
 * One-command install for the vault-side Archestra VAF Add On, rendered
 * first — it is the step that precedes everything else in the connection
 * workflow (the connection test and every sync preflight it), and its
 * installer ends by printing the Vault GUID the next field asks for. The
 * command
 * is one static line: the backend's script route serves a bootstrap that
 * runs the installer with the server-resolved package source, and the
 * installer asks for the vault interactively — so nothing from this form
 * ever rides in the command. Manual installation is the mutually exclusive
 * alternative tab, offering the newest released package when one exists.
 */
function MFilesVafAddOnSection() {
  // The add-on is this platform's own component, so a white-labeled
  // deployment installs it under its own brand.
  const appName = useAppName();
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const command = `irm '${origin}/api/mfiles-vaf-add-on/script' | iex`;

  // Probed on form open; the server verifies the package actually exists
  // (release asset or dev CI build) so this is never a dead link. Null just
  // means no pre-built package — the command then compiles from source and
  // no link is offered.
  const { data: distribution } = useMfilesVafAddOnDistribution();
  const downloadUrlRaw = distribution?.packageDownloadUrl ?? null;
  const downloadUrl =
    downloadUrlRaw?.startsWith("/") === true
      ? `${origin}${downloadUrlRaw}`
      : downloadUrlRaw;

  // The two install paths are mutually exclusive, so they render as tabs
  // (the connection page's pattern for alternatives) with the guided
  // script pre-selected.
  const commandCard = (
    <div className="rounded-md border bg-muted/30">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <code className="flex-1 whitespace-pre-wrap break-all font-mono text-xs">
          {command}
        </code>
        <CopyButton text={command} />
      </div>
      <div className="border-t px-2 py-1.5 text-xs text-muted-foreground">
        Downloads the Add On and installs it into the vault you choose. Run in
        PowerShell on the M-Files server as a system administrator.
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{appName} VAF Add On</p>
      {downloadUrl ? (
        <Tabs defaultValue="script">
          <TabsList>
            <TabsTrigger value="script">Installation script</TabsTrigger>
            <TabsTrigger value="manual">Manual installation</TabsTrigger>
          </TabsList>
          <TabsContent value="script">{commandCard}</TabsContent>
          <TabsContent value="manual">
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs text-muted-foreground">
                Download the Add On package and install it in M-Files Admin
                (right-click the vault, then Applications).
              </p>
              <Button variant="outline" size="sm" asChild>
                <a href={downloadUrl}>
                  <Download />
                  Download .mfappx
                </a>
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      ) : (
        // No pre-built package for this installation (the script compiles
        // from source) — the manual path doesn't exist, so no selector:
        // the command card is the only option.
        commandCard
      )}
      {/* Section description LAST, like a field's FormDescription sits under
          its input — same styling, same position in the label→control→
          description rhythm the rest of the form follows. */}
      <p className="text-muted-foreground text-sm">
        Required to sync M-Files Vault documents and permissions. Installed once
        per connected M-Files Vault by vault administrator.{" "}
        <ExternalDocsLink
          href={getFrontendDocsUrl(
            DocsPage.PlatformKnowledge,
            "m-files-vaf-add-on",
          )}
          className="text-sm"
        >
          Learn more
        </ExternalDocsLink>
      </p>
    </div>
  );
}

function TextField({
  form,
  name,
  label,
  placeholder,
  description,
  required,
}: {
  form: ConnectorForm;
  name: string;
  label: string;
  placeholder: string;
  description: string;
  required?: string;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      rules={required ? { required } : undefined}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormDescription>{description}</FormDescription>
          <FormControl>
            <Input
              placeholder={placeholder}
              {...field}
              value={(field.value as string | undefined) ?? ""}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
