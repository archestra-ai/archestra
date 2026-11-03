import { GITHUB_ACCOUNT_INPUT_INVALID } from "@archestra/shared";

/**
 * The one-line form of a GitHub App setup error, for a field's help line or
 * a row's hint, which keep their height when an error takes their place. An
 * unknown message is returned as it is; its line truncates and shows it whole
 * in a tooltip.
 */
export function shortGithubAppError(message: string): string {
  for (const [pattern, short] of SHORT_ERRORS) {
    const match = message.match(pattern);
    if (match)
      return short.replace(/\$(\d)/g, (_, group) => match[Number(group)] ?? "");
  }
  return message;
}

const SHORT_ERRORS: Array<[RegExp, string]> = [
  [
    /needs an organization on Copilot Business or Enterprise/,
    "That's a personal account. Use an organization.",
  ],
  [/^GitHub has no account named /, "No such organization on this GitHub."],
  [
    new RegExp(`^${escapeRegExp(GITHUB_ACCOUNT_INPUT_INVALID)}$`),
    "Enter the organization's name on GitHub.",
  ],
  [
    /^GitHub didn't return the .+ account\.$/,
    "GitHub didn't answer. Try again.",
  ],
  [/^GitHub App ID must be a number/, "The App ID is a number."],
  [/must be the RSA PEM file/, "That file isn't the App's private key (.pem)."],
  [
    /^GitHub doesn't recognize App (\S+) with this private key/,
    "GitHub doesn't know App $1 with this key.",
  ],
  [/^(.+) isn't installed on (\S+)\./, "$1 isn't installed on $2."],
  [
    /doesn't have the Copilot Requests permission/,
    "The App lacks the Copilot Requests permission.",
  ],
  [
    /doesn't allow Copilot requests from GitHub Apps/,
    "The organization doesn't allow Copilot requests from Apps.",
  ],
  [
    /^This plan is for (\S+), but the new App is installed on (\S+)\./,
    "This App is on $2, not $1.",
  ],
  [
    /credential this plan (?:uses|used) was deleted/,
    "This plan's App was deleted. Choose another App.",
  ],
  [
    /has no private key connected/,
    "That App has no private key here. Connect it by its key.",
  ],
  [
    /no longer exists on GitHub/,
    "The App was deleted on GitHub. Create it again.",
  ],
  [/setup expired/i, "Setup expired. Create the App again."],
  [
    /^GitHub didn't return the new App/,
    "GitHub didn't return the App. Start again.",
  ],
  [
    /^The App was created for (\S+), not (\S+)\./,
    "The App belongs to $1, not $2. Start again.",
  ],
  [
    /^You need permission to create provider keys/,
    "You can't create provider keys and credentials.",
  ],
  [
    /stored GitHub App credential is unreadable/,
    "The stored App can't be read. Reconnect it.",
  ],
  [
    /organization is unknown/,
    "The App's organization is unknown. Reconnect it.",
  ],
  [
    /Too many credentials share this App's name/,
    "Too many Apps with this name.",
  ],
];

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
