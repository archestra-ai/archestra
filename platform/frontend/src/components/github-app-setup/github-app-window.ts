/**
 * The GitHub tab a GitHub App setup works in, and the message its return page
 * sends back when GitHub finishes a step. Each setup names its own tab and
 * BroadcastChannel, so one setup's return never reaches another's dialog;
 * `window.opener` is no use because GitHub's opener policy severs it.
 */
type GithubAppSetupStep = "created" | "installed";

/** Opens (or reuses) the named tab, so the manifest post and the install land in one. */
export function openGithubWindow(url: string, tab: string) {
  return window.open(url, tab);
}

/** GitHub only accepts a manifest as a form post, so post one into the tab. */
export function postManifest(
  params: { url: string; manifest: string },
  tab: string,
) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = params.url;
  form.target = tab;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = params.manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

export function notifyGithubAppSetup(
  step: GithubAppSetupStep,
  channelName: string,
) {
  const channel = new BroadcastChannel(channelName);
  channel.postMessage({ step });
  channel.close();
}

export function onGithubAppSetup(
  listener: (step: GithubAppSetupStep) => void,
  channelName: string,
) {
  const channel = new BroadcastChannel(channelName);
  channel.onmessage = (event: MessageEvent<{ step?: unknown }>) => {
    if (event.data?.step === "created" || event.data?.step === "installed")
      listener(event.data.step);
  };
  return () => channel.close();
}
