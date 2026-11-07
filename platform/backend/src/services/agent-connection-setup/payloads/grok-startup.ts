export const GROK_STARTUP = String.raw`
class GrokStartup {
  constructor(args) {
    const agentHeadless = args.includes("agent") && !args.some(arg => ["stdio", "serve", "leader", "--help", "-h", "--version", "-v"].includes(arg));
    this.headless = agentHeadless || args.some(arg => /^(?:--(?:single|prompt-json|prompt-file|print)(?:=|$)|-p)/.test(arg));
    this.format = args.find(arg => arg.startsWith("--output-format="))?.slice(16) || args[args.indexOf("--output-format") + 1] || "plain";
    if (!args.some(arg => arg.startsWith("--output-format"))) this.format = "plain";
    this.visible = process.stdin.isTTY && process.stderr.isTTY && !this.headless && !args.includes("agent") && !args.some(arg => /^(?:--(?:sync|json|quiet|headless|print|output-format)(?:=|$)|-q$|-p)/.test(arg));
    this.showBeforeLaunch = this.visible && !args.some(arg => ["--version", "-v", "--help", "-h"].includes(arg));
    this.cancelled = 0;
    this.signal = signal => {
      this.cancelled = signal === "SIGINT" ? 130 : 143;
      if (!this.child) return;
      if (!this.preparing) this.child.kill(signal);
      else if (process.platform === "win32") require("node:child_process").spawnSync("taskkill.exe", ["/pid", String(this.child.pid), "/t", "/f"], { stdio: "ignore", shell: false, windowsHide: true });
      else { try { process.kill(-this.child.pid, signal); } catch {} }
    };
    process.on("SIGINT", this.signal);
    process.on("SIGTERM", this.signal);
    if (this.visible) process.stderr.write("Archestra / Grok managed startup\n");
  }
  checkConnectivity(url) {
    if (!this.headless) return;
    // Advisory health runs concurrently with local preparation and native inference.
    // Only the server-issued session receipt attests actual policy admission.
    this.stdoutAtBoundary = true;
    this.health = (async () => {
      if (!url) return { connectivity: "unavailable", admission: "await-server-receipt" };
      try {
        const response = await grokFetch(url, { redirect: "error", signal: AbortSignal.timeout(3000) });
        if (!response.ok) { await response.body?.cancel(); return { connectivity: "unavailable", admission: "await-server-receipt" }; }
        const reader = response.body?.getReader(); let bytes = 0, chunks = [];
        if (!reader) throw new Error("empty");
        try { for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > 16384) throw new Error("size"); chunks.push(item.value); } } finally { await reader.cancel().catch(() => {}); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const checks = [body.mcp, body.llm].filter(value => value !== undefined);
        return { connectivity: checks.length && checks.every(value => value === "ok") ? "ok" : checks.includes("down") ? "down" : "unavailable", admission: "await-server-receipt" };
      } catch { return { connectivity: "unreachable", admission: "await-server-receipt" }; }
    })();
    if (this.format === "plain") this.health.then(status => {
      this.healthStatus = status;
      if (this.stdoutAtBoundary) this.reportPlainStatus(status);
    });
  }
  reportPlainStatus(status) {
    if (this.healthReported) return;
    this.healthReported = true;
    process.stdout.write("[Archestra] Connectivity: " + status.connectivity + ". Guardrails admission is confirmed by the server receipt in the agent reply.\n");
  }
  writeStructured(text) {
    // Legacy PowerShell decodes native pipes using its console code page.
    // JSON escapes preserve every Unicode value without changing shell state.
    // Escape UTF-16 code units so supplementary characters keep both surrogates.
    process.stdout.write(text.replace(/[\u007f-\uffff]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")));
  }
  async reportHeadless(output) {
    const status = await this.health;
    if (this.format === "json") {
      // Native JSON is one final object; keep text and structuredOutput untouched.
      try { const value = JSON.parse(output); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape"); this.writeStructured(JSON.stringify({ ...value, _meta: { ...value._meta, archestraStartup: status } }) + "\n"); }
      catch { process.stdout.write(output); throw new Error("Grok returned invalid JSON; startup status could not be attached."); }
    } else if (this.format === "plain") {
      if (!this.healthReported && !this.stdoutAtBoundary) process.stdout.write("\n");
      this.reportPlainStatus(status);
    }
  }
  phase(name) {
    if (this.cancelled) throw new Error("Startup cancelled.");
    this.current = name;
    if (this.visible) process.stderr.write("[working] " + name);
  }
  complete(status, detail) {
    if (this.visible && this.current) process.stderr.write("\r\x1b[2K[" + status + "] " + this.current + ": " + detail + "\n");
    this.current = undefined;
  }
  prepare(mode, timeout) {
    return this.run(process.execPath, [__filename, mode], { preparing: true, timeout });
  }
  async launch(args, env) {
    // Full-screen Grok replaces this screen as soon as it starts. Match the
    // shared launcher's closing beat so the completed checks can be read.
    if (this.showBeforeLaunch) {
      process.stderr.write("Opening Grok shortly. Proxy admission awaits its first reply.\n");
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    this.phase("Native Grok");
    const status = await this.run("grok", args, { env, preparing: false, native: true });
    if (status !== 0) {
      this.phase("Native Grok");
      this.complete("failed", "native process exited with status " + status);
    }
    return status;
  }
  close(error) {
    if (error) {
      this.complete(this.cancelled ? "cancelled" : "failed", "preparation did not complete");
      process.stderr.write(this.cancelled ? "Startup cancelled.\n" : error instanceof SyntaxError ? "Managed state is invalid. Reconnect before launching.\n" : error.message + "\n");
    }
    process.removeListener("SIGINT", this.signal);
    process.removeListener("SIGTERM", this.signal);
  }
  run(command, args, options) {
    if (this.cancelled) return Promise.reject(new Error("Startup cancelled."));
    return new Promise((resolve, reject) => {
      const capture = options.native && this.headless;
      const child = require("node:child_process").spawn(command, args, { stdio: options.preparing ? ["ignore", "ignore", "pipe"] : capture ? ["inherit", "pipe", "inherit"] : "inherit", shell: false, env: options.env || process.env, detached: options.preparing && process.platform !== "win32", windowsHide: true });
      let diagnostic = "", output = "", line = "", lastLine = "";
      if (capture) child.stdout.setEncoding("utf8");
      if (capture) child.stdout.on("data", chunk => {
        if (this.format === "json") output += chunk.toString();
        else if (this.format === "streaming-json" || this.format === "streaming-messages-json") {
          line += chunk.toString();
          for (;;) { const at = line.indexOf("\n"); if (at < 0) break; const text = line.slice(0, at); line = line.slice(at + 1); if (lastLine) this.writeStructured(lastLine + "\n"); lastLine = text; }
        } else {
          process.stdout.write(chunk);
          this.stdoutAtBoundary = chunk.endsWith("\n");
          if (this.stdoutAtBoundary && this.healthStatus) this.reportPlainStatus(this.healthStatus);
        }
      });
      if (options.preparing) child.stderr.on("data", chunk => { if (diagnostic.length <= 2048) diagnostic += chunk.toString(); });
      this.child = child; this.preparing = options.preparing;
      if (options.native) child.once("spawn", () => this.complete("ok", "native process started; server receipt not yet observed"));
      let timedOut = false;
      const timer = options.timeout ? setTimeout(() => { timedOut = true; this.signal("SIGTERM"); }, options.timeout) : undefined;
      child.on("error", () => { clearTimeout(timer); this.child = undefined; reject(new Error(options.preparing ? "Managed preparation could not start." : "Grok could not start. Install Grok Build and make grok available on PATH.")); });
      child.on("close", async status => {
        clearTimeout(timer); this.child = undefined;
        if (timedOut) { this.cancelled = 0; reject(new Error("Managed preparation timed out. No native session was started.")); }
        else if (this.cancelled) reject(new Error("Startup cancelled."));
        else if (options.preparing && status !== 0) {
          let code;
          try { if (diagnostic.length <= 2048) code = JSON.parse(diagnostic).archestraError; } catch {}
          const name = /^GROK_CREDENTIAL_(XAI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)$/.exec(typeof code === "string" ? code : "")?.[1];
          reject(new Error(name ? "Set " + name + " in this terminal or choose a provider-backed personal virtual key. MCP login and skills are saved; MCP authorization does not supply an LLM API key. No native session was started." : "Managed preparation failed. Check the selected provider credential, model discovery or managed settings. MCP login and skills are saved. No native session was started."));
        }
        else {
          try {
            if (capture) {
              if (this.format === "streaming-json" || this.format === "streaming-messages-json") {
                if (line && lastLine) this.writeStructured(lastLine + "\n");
                const terminal = line || lastLine;
                const health = await this.health;
                try { const value = JSON.parse(terminal); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape"); this.writeStructured(JSON.stringify({ ...value, _meta: { ...value._meta, archestraStartup: health } }) + "\n"); }
                catch { process.stdout.write(terminal + "\n"); throw new Error("Grok returned invalid NDJSON; startup status could not be attached."); }
              } else await this.reportHeadless(output);
            }
            resolve(status ?? 1);
          } catch (error) { reject(error); }
        }
      });
    });
  }
}
`;
