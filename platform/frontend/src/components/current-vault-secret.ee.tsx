import { CheckCircle2 } from "lucide-react";

export function CurrentVaultSecret({
  selectedSecretPath,
  selectedSecretKey,
}: {
  selectedSecretPath: string | null;
  selectedSecretKey: string | null;
}) {
  const hasSavedVaultReference = selectedSecretPath && selectedSecretKey;

  return hasSavedVaultReference ? (
    <div className="space-y-2 p-3 rounded border bg-muted/50">
      <div className="flex items-center gap-2 text-sm">
        <CheckCircle2 className="h-4 w-4 text-green-600" />
        <span className="font-medium">Vault Secret:</span>
      </div>
      <div className="space-y-1 text-sm font-mono">
        <div>
          <span className="text-muted-foreground">Path: </span>
          {selectedSecretPath}
        </div>
        <div>
          <span className="text-muted-foreground">Key: </span>
          {selectedSecretKey}
        </div>
      </div>
    </div>
  ) : null;
}
