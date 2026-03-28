import type { FieldErrors, UseFormRegister } from "react-hook-form";
import type { ConnectorFormData } from "./create-connector-dialog";

interface NotionConfigFieldsProps {
  register: UseFormRegister<ConnectorFormData>;
  errors: FieldErrors<ConnectorFormData>;
}

export function NotionConfigFields({
  register,
}: NotionConfigFieldsProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Provide a{" "}
        <a
          href="https://www.notion.so/my-integrations"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline"
        >
          Notion Integration Token
        </a>{" "}
        (starts with <code>secret_</code>). No instance URL is required — Notion
        is cloud-only.
      </p>

      <div className="space-y-2">
        <label className="text-sm font-medium leading-none">
          Database IDs{" "}
          <span className="text-xs font-normal text-muted-foreground">
            (optional — leave empty to sync entire workspace)
          </span>
        </label>
        <textarea
          {...register("notion.databaseIds")}
          placeholder={"Enter Notion database IDs, comma-separated"}
          rows={3}
          className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <p className="text-xs text-muted-foreground">
          When specified, only pages from these databases will be synced. Comma-separated.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium leading-none">
          Page IDs{" "}
          <span className="text-xs font-normal text-muted-foreground">
            (optional)
          </span>
        </label>
        <textarea
          {...register("notion.pageIds")}
          placeholder={"Enter specific page IDs, comma-separated"}
          rows={3}
          className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <p className="text-xs text-muted-foreground">
          When specified, only these specific pages will be synced. Comma-separated.
        </p>
      </div>
    </div>
  );
}
