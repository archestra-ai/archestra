/** Separate pasted input from the submit key so terminal paste guards do not
 * consume Enter as a newline. This also applies while a CLI is busy: Enter
 * submits to its native steering/queue behavior.
 */
export function buildTmuxSteerCommand(params: {
  session: string;
  message: string;
}): string {
  const session = shellQuote(params.session);
  return `tmux send-keys -t ${session} -l -- ${shellQuote(params.message)} && sleep 1 && tmux send-keys -t ${session} Enter`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
