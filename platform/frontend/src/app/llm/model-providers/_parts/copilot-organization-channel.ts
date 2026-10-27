/**
 * Carries "App created" / "App installed" from the GitHub return tab back to
 * the Copilot organization connect dialog. A BroadcastChannel, not
 * `window.opener`: GitHub's opener policy severs the opener once the window
 * navigates through github.com.
 */
type CopilotAppSetupStep = "created" | "installed";

export function notifyCopilotAppSetup(step: CopilotAppSetupStep) {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ step });
  channel.close();
}

export function onCopilotAppSetup(
  listener: (step: CopilotAppSetupStep) => void,
) {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<{ step?: unknown }>) => {
    if (event.data?.step === "created" || event.data?.step === "installed")
      listener(event.data.step);
  };
  return () => channel.close();
}

const CHANNEL = "github-copilot-app-setup";
