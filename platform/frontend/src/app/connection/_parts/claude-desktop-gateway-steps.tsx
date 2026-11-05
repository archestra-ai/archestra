export function ClaudeDesktopGatewaySteps({
  gatewayName,
}: {
  gatewayName: string;
}) {
  return (
    <div className="space-y-3 text-sm text-muted-foreground">
      <p>
        The installer registers your gateway. Claude Desktop does not let
        installers enable connectors automatically, so you need to enable the
        gateway in your conversation.
      </p>
      <ol className="list-decimal space-y-3 pl-5">
        <li>
          After Desktop restarts, open <strong>Settings → Connectors</strong>.
          Select <strong>{gatewayName}</strong> and connect it if needed.
          Complete sign-in and approve access in your browser.
        </li>
        <li>
          In your conversation, open <strong>+ → Connectors</strong> and enable{" "}
          <strong>{gatewayName}</strong> if it is off. A connected checkmark in
          Settings does not confirm it is enabled for that conversation.
        </li>
        <li>Ask Claude to list the tools available from your gateway.</li>
      </ol>
    </div>
  );
}
