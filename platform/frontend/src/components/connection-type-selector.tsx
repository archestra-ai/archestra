"use client";

import { CodeText } from "@/components/code-text";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import config from "@/lib/config";
import { cn } from "@/lib/utils";

const { externalProxyUrl, internalProxyUrl } = config.api;

// Check if external URL was explicitly set or defaults to internal
const isExternalUrlSameAsInternal = externalProxyUrl === internalProxyUrl;

export type ConnectionType = "internal" | "external";

interface ConnectionTypeSelectorProps {
  value: ConnectionType;
  onChange: (value: ConnectionType) => void;
  gatewayName: string;
  idPrefix: string;
}

export function ConnectionTypeSelector({
  value,
  onChange,
  gatewayName,
  idPrefix,
}: ConnectionTypeSelectorProps) {
  const internalId = `${idPrefix}-internal`;
  const externalId = `${idPrefix}-external`;

  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">Connection type</Label>
      <RadioGroup
        value={value}
        onValueChange={(val) => onChange(val as ConnectionType)}
        className="flex flex-col gap-3"
      >
        <div className="flex items-start gap-3">
          <RadioGroupItem value="internal" id={internalId} className="mt-0.5" />
          <div className="flex flex-col gap-0.5">
            <Label htmlFor={internalId} className="font-normal cursor-pointer">
              Via Internal URL
            </Label>
            <span className="text-xs text-muted-foreground">
              Internal URL for in-cluster communication. This is the URL where
              the frontend connects to the backend API server.
            </span>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <RadioGroupItem
            value="external"
            id={externalId}
            className="mt-0.5"
            disabled={isExternalUrlSameAsInternal}
          />
          <div className="flex flex-col gap-0.5">
            <Label
              htmlFor={externalId}
              className={cn(
                "font-normal cursor-pointer",
                isExternalUrlSameAsInternal && "opacity-50",
              )}
            >
              Via External URL
            </Label>
            <span className="text-xs text-muted-foreground">
              External URL for connecting to {gatewayName} from outside the
              Kubernetes cluster.
            </span>
            {isExternalUrlSameAsInternal && (
              <span className="text-xs text-muted-foreground/70 italic">
                Note: Currently defaults to internal URL because{" "}
                <CodeText className="text-[10px]">
                  ARCHESTRA_API_EXTERNAL_BASE_URL
                </CodeText>{" "}
                is not set.
              </span>
            )}
          </div>
        </div>
      </RadioGroup>

      <p className="text-sm text-muted-foreground">
        The URLs are configurable via{" "}
        <CodeText className="text-xs">ARCHESTRA_API_BASE_URL</CodeText> and{" "}
        <CodeText className="text-xs">ARCHESTRA_API_EXTERNAL_BASE_URL</CodeText>{" "}
        environment variables. See{" "}
        <a
          href="https://archestra.ai/docs/platform-deployment#environment-variables"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500"
        >
          here
        </a>{" "}
        for more details.
      </p>
    </div>
  );
}
