export function a2aRemoteAgentNewHref() {
  return "/agents/a2a/new";
}

export function a2aRemoteAgentDetailHref(id: string) {
  return `/agents/a2a/${encodeURIComponent(id)}`;
}
