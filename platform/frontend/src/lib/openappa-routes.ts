const OPENAPPA_NON_CHAT_PATHS = [
  "/openappa/batteries",
  "/openappa/policy",
  "/openappa/chat",
];

/** The configure page and saved policy conversations render a full-height chat. */
export function isOpenAppaChatPath(pathname: string): boolean {
  return (
    pathname.startsWith("/openappa/") &&
    !OPENAPPA_NON_CHAT_PATHS.includes(pathname)
  );
}
