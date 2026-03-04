import { AuthErrorTool } from "./auth-error-tool";

interface AuthRequiredToolProps {
  toolName: string;
  catalogName: string;
  installUrl: string;
  /** When provided, opens the install dialog inline instead of navigating */
  onInstall?: () => void;
}

export function AuthRequiredTool({
  toolName,
  catalogName,
  installUrl,
  onInstall,
}: AuthRequiredToolProps) {
  return (
    <AuthErrorTool
      toolName={toolName}
      title="Authentication Required"
      description={
        <>
          No credentials found for &ldquo;{catalogName}&rdquo;. Set up your
          credentials to use this tool.
        </>
      }
      buttonText="Set up credentials"
      buttonUrl={installUrl}
      onAction={onInstall}
    />
  );
}
