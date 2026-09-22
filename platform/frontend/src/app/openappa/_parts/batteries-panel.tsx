"use client";

import { BatteryCharging, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  type BatteryInstall,
  type BatterySummary,
  useBatteries,
  useDeleteBatteryInstall,
  useDeleteBatteryPackage,
  useUpdateBatteryInstall,
  useUploadBatteryPackage,
} from "@/lib/openappa-batteries.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import { BATTERY_STATUS_LABELS } from "./policy-decorations";

export function BatteriesPanel() {
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
  if (batteries.isPending) return <Skeleton className="h-32 w-full" />;
  if (batteries.isError || !batteries.data)
    return (
      <QueryLoadError
        title="Could not load guardrails batteries"
        onRetry={() => batteries.refetch()}
      />
    );
  const installs = batteries.data.flatMap((battery) =>
    battery.installs.map((install) => ({ battery, install })),
  );
  const uploaded = batteries.data.filter(
    (battery) => battery.source === "upload",
  );
  const serverName = (catalogId: string) =>
    catalog.data
      ? (catalog.data.find((entry) => entry.id === catalogId)?.name ??
        "Removed server")
      : "";
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
              Provider policy packages that attach to MCP servers. A server the
              provider's battery recognizes gets it when its tools sync.
            </p>
          </div>
        </div>
        {canBind === true && (
          <Button variant="outline" onClick={() => setUploading(true)}>
            <Upload className="size-4" />
            <span>Upload package</span>
          </Button>
        )}
      </div>
      <div className="space-y-4 px-5 py-4">
        {installs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No battery is attached yet. Add an MCP server for one of the
            providers below and its battery attaches on the first tool sync.
          </p>
        ) : (
          <ul className="divide-y">
            {installs.map(({ battery, install }) => (
              <InstallRow
                key={install.id}
                battery={battery}
                install={install}
                serverName={serverName(install.catalogId)}
                canManage={canManage === true}
                canBind={canBind === true}
              />
            ))}
          </ul>
        )}
        {uploaded.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <h3 className="text-sm font-medium">Uploaded packages</h3>
            <ul className="space-y-1">
              {uploaded.map((battery) => (
                <PackageRow
                  key={battery.name}
                  battery={battery}
                  canManage={canManage === true}
                />
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          <span>Available: </span>
          <span>
            {batteries.data.map((battery) => battery.name).join(", ")}
          </span>
        </p>
      </div>
      {uploading && <UploadPackageDialog onOpenChange={setUploading} />}
    </section>
  );
}

const UNBOUND = "__unbound__";

function InstallRow({
  battery,
  install,
  serverName,
  canManage,
  canBind,
}: {
  battery: BatterySummary;
  install: BatteryInstall;
  serverName: string;
  canManage: boolean;
  canBind: boolean;
}) {
  const update = useUpdateBatteryInstall();
  const remove = useDeleteBatteryInstall();
  const [removing, setRemoving] = useState(false);
  const credentials = useRuntimeCredentials(
    canBind && battery.credentials.length > 0,
  );
  const options =
    credentials.data?.filter((credential) => credential.allowOrganization) ??
    [];
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{battery.name}</span>
          <Badge variant={STATUS_VARIANTS[install.status]}>
            {BATTERY_STATUS_LABELS[install.status]}
          </Badge>
          <span className="text-sm text-muted-foreground">{serverName}</span>
        </div>
        {battery.credentials.map((name) => {
          const id = `${install.id}-${name}`;
          return (
            <div key={name} className="flex flex-wrap items-center gap-2">
              <Label htmlFor={id} className="font-mono text-xs font-normal">
                {name}
              </Label>
              <Select
                value={install.credentialBindings[name] ?? UNBOUND}
                disabled={!canBind || update.isPending}
                onValueChange={(value) =>
                  update.mutate({
                    id: install.id,
                    body: {
                      credentialBindings: rebind(
                        install.credentialBindings,
                        name,
                        value,
                      ),
                    },
                  })
                }
              >
                <SelectTrigger id={id} className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNBOUND}>Not bound</SelectItem>
                  {options.map((credential) => (
                    <SelectItem key={credential.key} value={credential.key}>
                      {credential.organizationConfigured
                        ? credential.name
                        : `${credential.name} (no organization value)`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          aria-label={`Enable the ${battery.name} battery`}
          checked={install.enabled}
          disabled={!canManage || update.isPending}
          onCheckedChange={(enabled) =>
            update.mutate({ id: install.id, body: { enabled } })
          }
        />
        {canManage && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove the ${battery.name} battery`}
            onClick={() => setRemoving(true)}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      <DeleteConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove the ${battery.name} battery?`}
        description={`Its guardrails stop applying to ${serverName || "this server"}. The server's own tools are not affected.`}
        confirmLabel="Remove"
        pendingLabel="Removing…"
        isPending={remove.isPending}
        onConfirm={async () => {
          await remove.mutateAsync(install.id);
          setRemoving(false);
        }}
      />
    </li>
  );
}

function PackageRow({
  battery,
  canManage,
}: {
  battery: BatterySummary;
  canManage: boolean;
}) {
  const remove = useDeleteBatteryPackage();
  const [removing, setRemoving] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{battery.name}</span>
        <span className="text-muted-foreground">{battery.description}</span>
      </div>
      {canManage && (
        <Button
          variant="ghost"
          size="icon"
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
        description="Every install of this battery loses its policy until the package is uploaded again."
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

const STATUS_VARIANTS: Record<
  BatteryInstall["status"],
  "secondary" | "outline" | "destructive"
> = {
  active: "secondary",
  missing_credentials: "destructive",
  naming_conflict: "destructive",
  server_missing: "outline",
  refused: "destructive",
  unavailable: "destructive",
};

function rebind(
  bindings: BatteryInstall["credentialBindings"],
  name: string,
  value: string,
): BatteryInstall["credentialBindings"] {
  const { [name]: _, ...rest } = bindings;
  return value === UNBOUND ? rest : { ...rest, [name]: value };
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
