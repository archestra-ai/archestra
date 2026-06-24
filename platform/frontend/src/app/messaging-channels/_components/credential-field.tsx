export function CredentialField({
  label,
  value,
  optional,
}: {
  label: string;
  value?: string;
  optional?: boolean;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <span className="text-muted-foreground text-xs whitespace-nowrap">
        {label}
        {optional && " (optional)"}:
      </span>
      <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono">
        {value || "Not set"}
      </code>
    </div>
  );
}
