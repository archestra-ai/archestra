"use client";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface NotionConnectorFieldsProps {
  name: string;
  onNameChange: (name: string) => void;
  config: Record<string, unknown>;
  onConfigChange: (config: Record<string, unknown>) => void;
}

export function NotionConnectorFields({
  name,
  onNameChange,
  config,
  onConfigChange,
}: NotionConnectorFieldsProps) {
  const apiKey = (config.apiKey as string) ?? "";
  const pageIds = (config.pageIds as string) ?? "";
  const databaseIds = (config.databaseIds as string) ?? "";

  function update(key: string, value: unknown) {
    onConfigChange({ ...config, [key]: value });
  }

  return (
    <div className="space-y-4">
      {/* Connector name */}
      <div className="space-y-1.5">
        <Label htmlFor="notion-connector-name">Connector Name</Label>
        <Input
          id="notion-connector-name"
          placeholder="My Notion Workspace"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          required
        />
      </div>

      {/* Internal Integration Token */}
      <div className="space-y-1.5">
        <Label htmlFor="notion-api-key">
          Integration Token{" "}
          <span className="text-destructive" aria-hidden>
            *
          </span>
        </Label>
        <Input
          id="notion-api-key"
          type="password"
          placeholder="secret_..."
          value={apiKey}
          onChange={(e) => update("apiKey", e.target.value)}
          required
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Create an internal integration at{" "}
          <a
            href="https://www.notion.so/my-integrations"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            notion.so/my-integrations
          </a>{" "}
          and share the relevant pages with it.
        </p>
      </div>

      {/* Optional: specific page IDs */}
      <div className="space-y-1.5">
        <Label htmlFor="notion-page-ids">
          Page IDs{" "}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          id="notion-page-ids"
          placeholder={"One Notion page ID per line\ne.g. 1234abcd5678efgh"}
          value={pageIds}
          onChange={(e) => update("pageIds", e.target.value)}
          rows={3}
        />
        <p className="text-xs text-muted-foreground">
          Leave blank to sync all pages accessible to the integration.
        </p>
      </div>

      {/* Optional: specific database IDs */}
      <div className="space-y-1.5">
        <Label htmlFor="notion-database-ids">
          Database IDs{" "}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          id="notion-database-ids"
          placeholder={"One Notion database ID per line\ne.g. abcd1234efgh5678"}
          value={databaseIds}
          onChange={(e) => update("databaseIds", e.target.value)}
          rows={3}
        />
        <p className="text-xs text-muted-foreground">
          Specify databases to sync all pages within them.
        </p>
      </div>
    </div>
  );
}
