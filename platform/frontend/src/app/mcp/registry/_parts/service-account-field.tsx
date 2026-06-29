import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface ServiceAccountFieldProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  disabled?: boolean;
}

export function ServiceAccountField({
  value,
  onChange,
  disabled,
}: ServiceAccountFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="service-account">Service Account</Label>
      <Input
        id="service-account"
        placeholder="e.g., archestra-platform-mcp-k8s-operator"
        className="font-mono"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        disabled={disabled}
      />
      <p className="text-xs text-muted-foreground">
        Kubernetes service account name for the MCP server pod. Required for MCP
        servers that need access to the Kubernetes API.
        <br />
        Make sure this service account is available in{" "}
        <code className="bg-muted text-foreground px-1 py-0.5 rounded text-xs font-mono">
          {`kubectl get sa -n <namespace>`}
        </code>{" "}
        {`where <namespace> is MCP server namespace.`}
      </p>
    </div>
  );
}
