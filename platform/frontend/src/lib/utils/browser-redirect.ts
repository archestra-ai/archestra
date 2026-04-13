export function redirectBrowserToUrl(url: string) {
  window.location.assign(url);
}

export function replaceBrowserUrl(url: string) {
  window.location.replace(url);
}
