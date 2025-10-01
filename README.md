# Archestra Platform (alpha)

<div align="center">

[![License](https://img.shields.io/github/license/archestra-ai/archestra)](LICENSE)
<img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/archestra-ai/archestra"/>
<img alt="Github Last Commit" src="https://img.shields.io/github/last-commit/archestra-ai/archestra"/>
[![Contributors](https://img.shields.io/github/contributors/archestra-ai/archestra)](https://github.com/archestra-ai/archestra/graphs/contributors)

</div>

<p align="center">
  <a href="https://www.archestra.ai/docs/getting-started-desktop">Getting Started</a>
  - <a href="https://github.com/archestra-ai/archestra/releases">Releases</a>
  - <a href="https://github.com/archestra-ai/archestra/issues">Bug reports</a>
  - <a href="https://join.slack.com/t/archestracommunity/shared_invite/zt-39yk4skox-zBF1NoJ9u4t59OU8XxQChg">Slack Commuity</a>
</p>

A lightweight pluggable proxy bringing fine-grained guardrails to mitigate the Lethal Trifecta for external and internal agents.

- **Open Source**
- **Supports MCP, A2A, structured output, custom tool calls**
- **Guardrails**
- **Lightweight**

![Trifecta](/docs/assets/trifecta.png)

The Lethal Trifecta: [Simon Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), [The Economist](https://www.economist.com/leaders/2025/09/25/how-to-stop-ais-lethal-trifecta)

Examples of hacks:
[ChatGPT](https://simonwillison.net/2023/Apr/14/new-prompt-injection-attack-on-chatgpt-web-version-markdown-imag/) (April 2023), [ChatGPT Plugins](https://simonwillison.net/2023/May/19/chatgpt-prompt-injection/) (May 2023), [Google Bard](https://simonwillison.net/2023/Nov/4/hacking-google-bard-from-prompt-injection-to-data-exfiltration/) (November 2023), [Writer.com](https://simonwillison.net/2023/Dec/15/writercom-indirect-prompt-injection/) (December 2023), [Amazon Q](https://simonwillison.net/2024/Jan/19/aws-fixes-data-exfiltration/) (January 2024), [Google NotebookLM](https://simonwillison.net/2024/Apr/16/google-notebooklm-data-exfiltration/) (April 2024), [GitHub Copilot Chat](https://simonwillison.net/2024/Jun/16/github-copilot-chat-prompt-injection/) (June 2024), [Google AI Studio](https://simonwillison.net/2024/Aug/7/google-ai-studio-data-exfiltration-demo/) (August 2024), [Microsoft Copilot](https://simonwillison.net/2024/Aug/14/living-off-microsoft-copilot/) (August 2024), [Slack](https://simonwillison.net/2024/Aug/20/data-exfiltration-from-slack-ai/) (August 2024), [Mistral Le Chat](https://simonwillison.net/2024/Oct/22/imprompter/) (October 2024), [xAI's Grok](https://simonwillison.net/2024/Dec/16/security-probllms-in-xais-grok/) (December 2024), [Anthropic's Claude iOS app](https://simonwillison.net/2024/Dec/17/johann-rehberger/) (December 2024), [ChatGPT Operator](https://simonwillison.net/2025/Feb/17/chatgpt-operator-prompt-injection/) (February 2025), [Notion 3.0](https://www.codeintegrity.ai/blog/notion) (September 2025).

## Development

Before you begin, ensure you have the following installed:

- Node.js (v18 or higher)
- pnpm (v8 or higher) - Install with npm install -g pnpm
- [Tilt](https://docs.tilt.dev/install.html)
- [kubectl](https://kubernetes.io/docs/tasks/tools/install-kubectl-macos/)
- Local k8s cluster (Docker Desktop with k8s enabled, Kind or Orbstack)
- [Biome VSCode extension](https://open-vsx.org/extension/biomejs/biome)
- Git

Run dev environment

```bash
git clone https://github.com/archestra-ai/archestra.git
cd archestra/platform
tilt up
```

# Archestra Desktop, the Most Simple and Safe MCP Client

- 🔥 **Unique Authentication** — No need to toss API keys and config files to run MCP!
- 🔒 **Sandboxed MCP Runtime** — Isolated sandbox protecting the host from supply chain attacks.
- 🔌 **Full OSS MCPs Support** — Compatible with thousands of existing MCP servers.
- 💻 **Local-First Architecture** — Privacy-focused design with local LLM.

**[Read more about Archestra Desktop](/desktop_app/README.md)**

## 🤝 Contributing

We welcome contributions from the community! [Contribution guideline](https://www.archestra.ai/docs/contributing).

Thank you for contributing and continuously making <b>Archestra</b> better, <b>you're awesome</b> 🫶

<a href="https://github.com/archestra-ai/archestra/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=archestra-ai/archestra" />
</a>

---

<div align="center">
  <br />
  <a href="https://www.archestra.ai/blog/archestra-joins-cncf-linux-foundation"><img src="./docs/assets/linux-foundation-logo.png" height="50" alt="Linux Foundation" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://www.archestra.ai/blog/archestra-joins-cncf-linux-foundation"><img src="./docs/assets/cncf-logo.png" height="50" alt="CNCF" /></a>
</div>
