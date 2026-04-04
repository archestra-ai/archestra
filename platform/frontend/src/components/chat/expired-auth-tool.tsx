import { AuthErrorTool } from "./auth-error-tool";

interface ExpiredAuthToolProps {
  toolName: string;
  catalogName: string;
  reauthUrl: string;
  /** When provided, triggers inline re-authentication instead of navigating */
  onReauth?: () => void;
}

export function ExpiredAuthTool({
  toolName,
  catalogName,
  reauthUrl,
  onReauth,
}: ExpiredAuthToolProps) {
  const displayName = catalogName || toolName || "this tool";

  return (
    <AuthErrorTool
      title="Expired / Invalid Authentication"
      description={
        <>
          Your credentials for &ldquo;{displayName}&rdquo; have expired or are
          invalid. Re-authenticate to continue using this tool.
        </>
      }
      buttonText={onReauth ? "Re-authenticate" : "Manage credentials"}
      buttonUrl={reauthUrl}
      onAction={onReauth}
    />
  );
}
