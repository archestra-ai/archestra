/**
 * Carries "App created" / "App installed" from the GitHub callback window back
 * to the setup dialog. A BroadcastChannel, not `window.opener`: GitHub's
 * opener policy severs the opener once the window navigates through github.com.
 */
type GithubAppSetupStep = "created" | "installed";

export function notifyGithubAppSetup(step: GithubAppSetupStep) {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage({ step });
  channel.close();
}

export function onGithubAppSetup(listener: (step: GithubAppSetupStep) => void) {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<{ step?: unknown }>) => {
    if (event.data?.step === "created" || event.data?.step === "installed")
      listener(event.data.step);
  };
  return () => channel.close();
}

const CHANNEL = "openappa-github-app-setup";
