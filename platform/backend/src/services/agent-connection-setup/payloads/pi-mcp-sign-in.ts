/** Native Pi auth uses only the selected gateway's official login/logout commands. */
export const PI_MCP_SIGN_IN = `
async function signInPiGateway({ config, root, lifecycle }) {
  const { spawn } = require("node:child_process");
  const { PiInstallation } = require(lifecycle);
  const install = new PiInstallation();
  install.validate();
  const server = install.state.server;
  // Run outside the caller's project so a trusted project MCP override cannot
  // redirect the selected global gateway or its scoped logout.
  const cwd = root;
  const run = (action, observe = false) => new Promise((resolve, reject) => {
    const args = [...config.piCommand.slice(1), "mcp", action, server, ...(action === "login" ? ["--timeout", "120"] : [])];
    const child = spawn(config.piCommand[0], args, { cwd, shell: false, stdio: ["inherit", observe ? "pipe" : "inherit", "inherit"], timeout: 130000 });
    let output = "";
    child.stdout?.on("data", chunk => {
      process.stdout.write(chunk);
      output = (output + chunk.toString()).slice(-8192);
    });
    child.on("error", () => reject(new Error("Pi MCP sign-in could not start. Run arcpi --reconnect to retry.")));
    child.on("close", code => resolve({ ok: code === 0, cached: output.includes('Already signed in to MCP server "' + server + '" (') }));
  });
  const recordClient = () => {
    install.lock();
    try {
      install.validate();
      const auth = install.readJson(require("node:path").join(install.home, ".pi/agent/mcp-auth.json")) || {};
      const entry = auth[install.state.authKey];
      if (entry?.serverUrl !== install.state.gateway || !entry.clientInformation?.client_id) throw new Error("Pi sign-in did not save the expected gateway authorization. Run arcpi --reconnect to retry.");
      install.state.authClient = entry.clientInformation.client_id;
      install.persist();
    } finally { install.unlock(); }
  };
  // Official Pi probes this gateway before login: valid auth produces its
  // documented cached response; missing/expired auth takes the browser flow.
  const initial = await run("login", true);
  if (!initial.ok) throw new Error("Pi MCP sign-in did not finish. Run arcpi --reconnect to retry.");
  if (!initial.cached) { recordClient(); return; }
  const readline = require("node:readline/promises").createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = (await readline.question("Already signed in. [K] Keep existing login (default), [R] Sign in again, [C] Cancel: ")).trim().toLowerCase();
  } finally { readline.close(); }
  if (answer === "" || answer === "k" || answer === "keep") {
    console.log("Keeping the existing gateway login. No browser authorization or logout was requested.");
    return;
  }
  if (answer !== "r" && answer !== "sign in again") {
    console.log("Sign-in cancelled. The existing gateway login was kept.");
    throw new Error("Sign-in cancelled.");
  }
  if (!(await run("logout")).ok) throw new Error("Pi could not sign out of this gateway. No new login was started. Run arcpi --reconnect to retry.");
  console.log("The previous gateway login was signed out. Signing in again; if authorization does not finish, run arcpi --reconnect to retry. Other gateways are unchanged.");
  const renewed = await run("login", true);
  if (!renewed.ok || renewed.cached) throw new Error("Fresh gateway sign-in did not finish. The previous login was signed out; run arcpi --reconnect to retry. Other gateways were not changed.");
  recordClient();
}
`;
