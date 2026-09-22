"use client";

import {
  AlertTriangle,
  BatteryCharging,
  GitPullRequestArrow,
  LockKeyhole,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  type BatterySummary,
  type PolicyBattery,
  type PolicyDeclarations,
  useAcceptHeldPull,
  useBatteries,
  useCreateBatteryInstall,
  useDeleteBatteryInstall,
  useDeleteBatteryPackage,
  usePolicyDeclarations,
  useUpdateBatteryInstall,
  useUploadBatteryPackage,
} from "@/lib/openappa-batteries.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import { BATTERY_STATUS_BADGES } from "./policy-decorations";

/**
 * What the organization's policy text includes, as the text declares it. The
 * battery list is a read of the document, not of a table: an entry is included
 * because a line spells it, and every control here edits that line.
 */
export function BatteriesPanel() {
  const declarations = usePolicyDeclarations();
  const batteries = useBatteries();
  const catalog = useInternalMcpCatalog();
  const { data: canManage } = useHasPermissions({
    organization: ["update"],
    toolPolicy: ["update"],
  });
  // Binding a credential hands its value to helper code, and an uploaded
  // package may carry such code, so both take the credential permission too.
  const { data: canBind } = useHasPermissions({
    organization: ["update"],
    toolPolicy: ["update"],
    credential: ["update"],
  });
  const [uploading, setUploading] = useState(false);
  if (declarations.isPending || batteries.isPending)
    return <Skeleton className="h-32 w-full" />;
  if (!declarations.data || !batteries.data)
    return (
      <QueryLoadError
        title="Could not load guardrails batteries"
        onRetry={() => {
          declarations.refetch();
          batteries.refetch();
        }}
      />
    );
  const { lastError, managedInGithub, heldPull } = declarations.data;
  const included = declarations.data.batteries;
  // A composition that failed is not what the runtime enforces, whatever each
  // entry resolved to, so no entry may claim to be active.
  const enforced = lastError === null;
  // The repository owns the text while it syncs: an edit here would be undone
  // by the next pull, so the panel only reads.
  const writable = canManage === true && !managedInGithub;
  const bindable = canBind === true && !managedInGithub;
  // Unknown while the catalog loads; only a loaded catalog can say a server is gone.
  const catalogName = (catalogId: string) =>
    catalog.data
      ? (catalog.data.find((entry) => entry.id === catalogId)?.name ??
        "Removed server")
      : "";
  const installsOf = (name: string) =>
    batteries.data
      .find((battery) => battery.name === name)
      ?.installs.map((install) => ({
        id: install.id,
        catalogId: install.catalogId,
      })) ?? [];
  const includedHashes = new Set(
    included
      .map((battery) => battery.packageHash)
      .filter((hash): hash is string => hash !== null),
  );
  const uploaded = batteries.data.filter(
    (battery) => battery.source === "upload",
  );
  return (
    <section
      aria-label="Guardrails batteries"
      className="rounded-lg border bg-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4">
        <div className="flex min-w-0 flex-1 gap-3">
          <BatteryCharging className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <h2 className="font-semibold">Batteries</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Provider policy packages the organization's policy text includes.
              Attaching one writes its include line and the aliases that point
              it at a server.
            </p>
          </div>
        </div>
        {bindable && (
          <Button variant="outline" onClick={() => setUploading(true)}>
            <Upload className="size-4" />
            <span>Upload package</span>
          </Button>
        )}
      </div>
      <div className="space-y-4 px-5 py-4">
        {lastError !== null && (
          <InlineNotice variant="error">
            <AlertTriangle />
            <span className="font-medium">Batteries are not enforced</span>
            <InlineNoticeText>{lastError}</InlineNoticeText>
          </InlineNotice>
        )}
        {managedInGithub && (
          <InlineNotice variant="neutral">
            <LockKeyhole />
            <span className="font-medium">Managed in GitHub</span>
            <InlineNoticeText>
              The repository owns this policy. Change its batteries there.
            </InlineNoticeText>
          </InlineNotice>
        )}
        {heldPull !== null && (
          <HeldPullNotice
            heldPull={heldPull}
            canManage={canManage === true}
            canBind={canBind === true}
          />
        )}
        {included.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The policy includes no battery yet. Attach one to a server below.
          </p>
        ) : (
          <ul className="divide-y">
            {included.map((battery) => (
              <IncludedBattery
                key={battery.entry}
                battery={battery}
                installs={installsOf(battery.name)}
                catalogName={catalogName}
                enforced={enforced}
                writable={writable}
                bindable={bindable}
              />
            ))}
          </ul>
        )}
        {writable && (
          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-medium">Attach a battery</h3>
            {batteries.data.map((battery) => (
              <AttachRow
                key={battery.name}
                battery={battery}
                included={included.find((entry) => entry.name === battery.name)}
                catalog={catalog.data ?? []}
              />
            ))}
          </div>
        )}
        {declarations.data.unusedAliases.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-medium">Unused aliases</h3>
            {declarations.data.unusedAliases.map((alias) => (
              <div
                key={alias.namespace}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                <span className="font-mono text-xs">{alias.namespace}</span>
                <span className="text-muted-foreground">→</span>
                <span className="text-muted-foreground">
                  {alias.servers.join(", ")}
                </span>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              No included battery declares this namespace.
            </p>
          </div>
        )}
        {uploaded.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-medium">Uploaded packages</h3>
            <ul className="space-y-1">
              {uploaded.map((battery) => (
                <PackageRow
                  key={battery.name}
                  battery={battery}
                  canManage={writable}
                  isIncluded={
                    battery.contentHash !== null &&
                    includedHashes.has(battery.contentHash)
                  }
                />
              ))}
            </ul>
          </div>
        )}
      </div>
      {uploading && <UploadPackageDialog onOpenChange={setUploading} />}
    </section>
  );
}

const UNBOUND = "__unbound__";

/** A battery install as this panel needs it: the row id behind one catalog. */
type InstallRef = { id: string; catalogId: string };

function HeldPullNotice({
  heldPull,
  canManage,
  canBind,
}: {
  heldPull: NonNullable<PolicyDeclarations["heldPull"]>;
  canManage: boolean;
  canBind: boolean;
}) {
  const accept = useAcceptHeldPull();
  // Publishing the held text performs what it was held for: dropping an entry
  // is a policy edit, rebinding a variable hands a credential to other code.
  const mayAccept = heldPull.reasons.includes("changes_credentials")
    ? canBind
    : canManage;
  return (
    <InlineNotice variant="warning">
      <GitPullRequestArrow />
      <span className="font-medium">Repository text held</span>
      <InlineNoticeText>
        {heldPull.reasons.map((reason) => (
          <div key={reason}>{HELD_PULL_REASONS[reason]}</div>
        ))}
      </InlineNoticeText>
      {mayAccept && (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={accept.isPending}
          onClick={() => accept.mutate()}
        >
          <span>Accept repository text</span>
        </Button>
      )}
    </InlineNotice>
  );
}

function IncludedBattery({
  battery,
  installs,
  catalogName,
  enforced,
  writable,
  bindable,
}: {
  battery: PolicyBattery;
  installs: InstallRef[];
  catalogName: (catalogId: string) => string;
  enforced: boolean;
  writable: boolean;
  bindable: boolean;
}) {
  const remove = useDeleteBatteryInstall();
  const [removing, setRemoving] = useState(false);
  const status = enforced ? battery.status : "refused";
  const source =
    battery.source === "bundled"
      ? "Bundled"
      : `Upload ${battery.packageHash?.slice(0, 12) ?? "unknown"}`;
  return (
    <li className="space-y-2 py-3" aria-label={`${battery.name} battery`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{battery.name}</span>
        <Badge variant="outline">{source}</Badge>
        <Badge variant={BATTERY_STATUS_BADGES[status].variant}>
          {BATTERY_STATUS_BADGES[status].label}
        </Badge>
        {writable && installs.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto"
            aria-label={`Remove the ${battery.name} battery`}
            onClick={() => setRemoving(true)}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
        {writable && installs.length === 0 && (
          // An include with no install row is removed by editing the text:
          // every panel write goes through an install.
          <span className="ml-auto text-xs text-muted-foreground">
            Remove its include line in the policy editor.
          </span>
        )}
      </div>
      {battery.servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No alias points this battery at a server.
        </p>
      ) : (
        battery.servers.map((server) => (
          <ServerRow
            key={server.target}
            batteryName={battery.name}
            target={server.target}
            name={
              server.catalogId === null
                ? "Removed server"
                : catalogName(server.catalogId)
            }
            install={
              installs.find(
                ({ catalogId }) => catalogId === server.catalogId,
              ) ?? null
            }
            writable={writable}
          />
        ))
      )}
      {battery.credentials.map((credential) => (
        <CredentialRow
          key={credential.variable}
          batteryName={battery.name}
          credential={credential}
          bindings={bindingsOf(battery)}
          install={installs[0] ?? null}
          bindable={bindable}
        />
      ))}
      <DeleteConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove the ${battery.name} battery?`}
        description="Its include line leaves the policy text and its guardrails stop applying to every server it governed."
        confirmLabel="Remove"
        pendingLabel="Removing…"
        isPending={remove.isPending}
        onConfirm={async () => {
          // Independent rows go together; whatever failed, the refetch shows
          // what is left and the dialog never outlives the attempt.
          try {
            await Promise.all(
              installs.map((install) => remove.mutateAsync(install.id)),
            );
          } finally {
            setRemoving(false);
          }
        }}
      />
    </li>
  );
}

function ServerRow({
  batteryName,
  target,
  name,
  install,
  writable,
}: {
  batteryName: string;
  target: string;
  name: string;
  install: InstallRef | null;
  writable: boolean;
}) {
  const remove = useDeleteBatteryInstall();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-mono text-xs">{target}</span>
      <span className="text-muted-foreground">{name}</span>
      {writable && install !== null && (
        <Button
          variant="ghost"
          size="sm"
          disabled={remove.isPending}
          aria-label={`Detach ${batteryName} from ${name}`}
          onClick={() => remove.mutate(install.id)}
        >
          <span>Detach</span>
        </Button>
      )}
    </div>
  );
}

function CredentialRow({
  batteryName,
  credential,
  bindings,
  install,
  bindable,
}: {
  batteryName: string;
  credential: PolicyBattery["credentials"][number];
  bindings: Record<string, string>;
  install: InstallRef | null;
  bindable: boolean;
}) {
  const update = useUpdateBatteryInstall();
  const [kept, setKept] = useState(false);
  const credentials = useRuntimeCredentials(bindable);
  const others = credential.readers.filter((reader) => reader !== batteryName);
  const options =
    credentials.data?.filter((entry) => entry.allowOrganization) ?? [];
  // The policy can name a key the list no longer offers — deleted, or closed
  // to the organization — and the binding still has to read as what it is.
  const unlisted =
    credential.key !== null &&
    credentials.data !== undefined &&
    !options.some((entry) => entry.key === credential.key)
      ? credential.key
      : null;
  const id = `${batteryName}-${credential.variable}`;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={id} className="font-mono text-xs font-normal">
          {credential.variable}
        </Label>
        <Select
          value={credential.key ?? UNBOUND}
          disabled={!bindable || install === null || update.isPending}
          onValueChange={(value) => {
            // The table is one per organization: letting go of a variable the
            // other entries read would take the key from them too, so the
            // unset is never sent and the row says why.
            if (value === UNBOUND && others.length > 0) return setKept(true);
            setKept(false);
            if (install === null) return;
            update.mutate({
              id: install.id,
              body: {
                credentialBindings: rebind(
                  bindings,
                  credential.variable,
                  value,
                ),
              },
            });
          }}
        >
          <SelectTrigger id={id} className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNBOUND}>Not bound</SelectItem>
            {unlisted !== null && (
              <SelectItem value={unlisted} disabled>
                {`${unlisted} (not available)`}
              </SelectItem>
            )}
            {options.map((entry) => (
              <SelectItem key={entry.key} value={entry.key}>
                {entry.organizationConfigured
                  ? entry.name
                  : `${entry.name} (no organization value)`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {others.length > 0 && (
          <span className="text-xs text-muted-foreground">
            Also read by: {others.join(", ")}
          </span>
        )}
      </div>
      {kept && (
        <InlineNotice variant="neutral">
          <span className="font-medium">The key stays</span>
          <InlineNoticeText>
            {others.join(", ")} still read this variable. Remove those batteries
            to unbind it.
          </InlineNoticeText>
        </InlineNotice>
      )}
    </div>
  );
}

function AttachRow({
  battery,
  included,
  catalog,
}: {
  battery: BatterySummary;
  included: PolicyBattery | undefined;
  catalog: { id: string; name: string }[];
}) {
  const create = useCreateBatteryInstall();
  const attached = new Set(
    included?.servers
      .map((server) => server.catalogId)
      .filter((catalogId): catalogId is string => catalogId !== null) ?? [],
  );
  const options = catalog.filter((entry) => !attached.has(entry.id));
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{battery.name}</span>
      <span className="text-muted-foreground">{battery.description}</span>
      <Select
        // Attaching is an action, not a state: the row goes back to its
        // prompt and the choice shows up in the included list above.
        value=""
        disabled={create.isPending || options.length === 0}
        onValueChange={(catalogId) =>
          create.mutate({ batteryName: battery.name, catalogId })
        }
      >
        <SelectTrigger
          className="ml-auto w-64"
          aria-label={`Attach the ${battery.name} battery to a server`}
        >
          <SelectValue placeholder="Attach to server…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function PackageRow({
  battery,
  canManage,
  isIncluded,
}: {
  battery: BatterySummary;
  canManage: boolean;
  isIncluded: boolean;
}) {
  const remove = useDeleteBatteryPackage();
  const [removing, setRemoving] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{battery.name}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {battery.contentHash?.slice(0, 12) ?? ""}
        </span>
        <span className="text-muted-foreground">{battery.description}</span>
      </div>
      {canManage && (
        <Button
          variant="ghost"
          size="icon"
          disabled={isIncluded}
          title={isIncluded ? "Included by the policy" : undefined}
          aria-label={`Delete the ${battery.name} package`}
          onClick={() => setRemoving(true)}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
      <DeleteConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Delete the ${battery.name} package?`}
        description="The policy can no longer include this version of the battery."
        isPending={remove.isPending}
        onConfirm={async () => {
          if (battery.contentHash)
            await remove.mutateAsync(battery.contentHash);
          setRemoving(false);
        }}
      />
    </li>
  );
}

function UploadPackageDialog({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const upload = useUploadBatteryPackage();
  const [name, setName] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  // Not in React's attribute typings; lets the picker take a whole folder.
  useEffect(() => picker.current?.setAttribute("webkitdirectory", ""), []);
  return (
    <StandardFormDialog
      open
      onOpenChange={onOpenChange}
      title="Upload a battery package"
      description="Pick the package folder: its manifest, policy and helper scripts."
      size="medium"
      bodyClassName="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        upload.mutate(
          { name: name.trim(), files: await readPackage(files) },
          { onSuccess: () => onOpenChange(false) },
        );
      }}
      footer={
        <>
          <DialogCancelButton disabled={upload.isPending} />
          <Button
            type="submit"
            disabled={upload.isPending || files.length === 0}
          >
            <span>{upload.isPending ? "Uploading…" : "Upload"}</span>
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="battery-package-name">Name</Label>
        <Input
          id="battery-package-name"
          value={name}
          required
          pattern="[a-z0-9][a-z0-9\-]*"
          placeholder="acme"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="battery-package-files">Package folder</Label>
        <Input
          id="battery-package-files"
          type="file"
          multiple
          ref={picker}
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
      </div>
    </StandardFormDialog>
  );
}

const HELD_PULL_REASONS: Record<
  NonNullable<PolicyDeclarations["heldPull"]>["reasons"][number],
  string
> = {
  drops_batteries:
    "The repository text drops batteries this deployment declared",
  changes_credentials:
    "The repository text changes which credentials batteries read",
};

/** The `[credentials]` rows this entry owns, as a PATCH body spells them. */
function bindingsOf(battery: PolicyBattery): Record<string, string> {
  return Object.fromEntries(
    battery.credentials
      .filter((credential) => credential.key !== null)
      .map((credential) => [credential.variable, credential.key as string]),
  );
}

function rebind(
  bindings: Record<string, string>,
  variable: string,
  value: string,
): Record<string, string> {
  const { [variable]: _, ...rest } = bindings;
  return value === UNBOUND ? rest : { ...rest, [variable]: value };
}

/** Package files keyed by their path inside the picked folder. */
async function readPackage(files: File[]) {
  const paths = files.map((file) => file.webkitRelativePath || file.name);
  const slash = paths[0]?.indexOf("/") ?? -1;
  const root = slash === -1 ? "" : (paths[0]?.slice(0, slash + 1) ?? "");
  const shared = root !== "" && paths.every((path) => path.startsWith(root));
  return Promise.all(
    files.map(async (file, index) => ({
      path: shared ? paths[index].slice(root.length) : paths[index],
      text: await file.text(),
    })),
  );
}
