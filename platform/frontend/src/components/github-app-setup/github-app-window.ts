/**
 * The GitHub tab a GitHub App setup works in, and the message the return page
 * sends back when GitHub finishes a step. One BroadcastChannel for every
 * setup (Guardrails, GitHub Copilot): only the open setup dialog listens, and
 * `window.opener` is no use because GitHub's opener policy severs it.
 */
type GithubAppSetupStep = "created" | "installed";

/** Opens (or reuses) the named tab, so the manifest post and the install land in one. */
export function openGithubWindow(url: string) {
  return window.open(url, GITHUB_WINDOW);
}

/** GitHub only accepts a manifest as a form post, so post one into the tab. */
export function postManifest(params: { url: string; manifest: string }) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = params.url;
  form.target = GITHUB_WINDOW;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = params.manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

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

const GITHUB_WINDOW = "github-app-setup";
const CHANNEL = "github-app-setup";
