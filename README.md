# Centralized AI Platform for MCP era

Centralize and simplify AI usage in the enterprise, providing observability and control built on a strong security foundation.

*For Platform teams:*
- Mitigate MCP chaos, move MCP servers from individual machines to a centralized orchestrator
- Manage MCP-data access
- Mitigate data exfiltration risks
- Manage token usage
- Collect logs and metrics 

*For Developers:*
- Deploy your MCP servers org-wide
- Build and deploy agents without worrying about security

*For Management:*
- Bring 1-click MCP adoption to the whole organization for technical and non-technical users
- Reduce AI costs up to 96%
- Get full visibility on AI adoption, usage and data access

<div align="center">

[![License](https://img.shields.io/github/license/archestra-ai/archestra)](LICENSE)
<img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/archestra-ai/archestra"/>
<img alt="Github Last Commit" src="https://img.shields.io/github/last-commit/archestra-ai/archestra"/>
[![Contributors](https://img.shields.io/github/contributors/archestra-ai/archestra)](https://github.com/archestra-ai/archestra/graphs/contributors)

<p align="center">
  <a href="https://www.archestra.ai/docs/platform-quickstart">Getting Started</a>
  - <a href="https://github.com/archestra-ai/archestra/releases">Releases</a>
  - <a href="https://join.slack.com/t/archestracommunity/shared_invite/zt-39yk4skox-zBF1NoJ9u4t59OU8XxQChg">Slack Community</a>
</p>
</div>

## 🔥 ChatGPT-like chat with MCPs

<div align="center">
<img src="docs/assets/chat.png" alt="MCP Registry" />
</div>

## 🔥 Private MCP Registry with Governance

Add MCPs to your private registry to share them with your team: self-hosted and remote, self-built and third-party.

<div align="center">
<img src="docs/assets/mcp-registry.png" alt="MCP Registry" />
</div>

## 🔥 Cloud-native MCP orchestrator

Running MCP servers in K8S, managing their state, API keys, OAuth.

<div align="center">
<img src="docs/assets/orchestrator.png" alt="MCP Registry" />
</div>

## 🔥 Security sub-agents

### Dual-llm sub-agent

Isolating dangerous tool responses from the main agent to prevent prompt injections.

<div align="center">
<img src="docs/assets/dual-llm.png" alt="MCP Registry" />
</div>


## 🔥 Dynamic tool call blocking to prevent data exfiltration

Models could consume prompt injections via MCP uncontrollably (read your inbox, read your GitHub issues, read your customer's inquiries) and follow them resulting in data exfiltration. 

Live demo of archestra security engine preventing data leak from the private GitHub repo to the public repo:
[![Archestra Demo](https://img.youtube.com/vi/SkmluS-xzmM/0.jpg)](https://www.youtube.com/watch?v=SkmluS-xzmM&t=2155s)

Read more: [Simon Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), [The Economist](https://www.economist.com/leaders/2025/09/25/how-to-stop-ais-lethal-trifecta)

Examples of hacks:
[ChatGPT](https://simonwillison.net/2023/Apr/14/new-prompt-injection-attack-on-chatgpt-web-version-markdown-imag/) (April 2023), [ChatGPT Plugins](https://simonwillison.net/2023/May/19/chatgpt-prompt-injection/) (May 2023), [Google Bard](https://simonwillison.net/2023/Nov/4/hacking-google-bard-from-prompt-injection-to-data-exfiltration/) (November 2023), [Writer.com](https://simonwillison.net/2023/Dec/15/writercom-indirect-prompt-injection/) (December 2023), [Amazon Q](https://simonwillison.net/2024/Jan/19/aws-fixes-data-exfiltration/) (January 2024), [Google NotebookLM](https://simonwillison.net/2024/Apr/16/google-notebooklm-data-exfiltration/) (April 2024), [GitHub Copilot Chat](https://simonwillison.net/2024/Jun/16/github-copilot-chat-prompt-injection/) (June 2024), [Google AI Studio](https://simonwillison.net/2024/Aug/7/google-ai-studio-data-exfiltration-demo/) (August 2024), [Microsoft Copilot](https://simonwillison.net/2024/Aug/14/living-off-microsoft-copilot/) (August 2024), [Slack](https://simonwillison.net/2024/Aug/20/data-exfiltration-from-slack-ai/) (August 2024), [Mistral Le Chat](https://simonwillison.net/2024/Oct/22/imprompter/) (October 2024), [xAI's Grok](https://simonwillison.net/2024/Dec/16/security-probllms-in-xais-grok/) (December 2024), [Anthropic's Claude iOS app](https://simonwillison.net/2024/Dec/17/johann-rehberger/) (December 2024), [ChatGPT Operator](https://simonwillison.net/2025/Feb/17/chatgpt-operator-prompt-injection/) (February 2025), [Notion 3.0](https://www.codeintegrity.ai/blog/notion) (September 2024).

## 🚀 Quickstart

1. Start with Docker

   ```bash
   docker pull archestra/platform:latest;
   docker run -p 9000:9000 -p 3000:3000 archestra/platform
   ```

2. Open <http://localhost:3000>

3. The platform is now running with:
   - Web UI at <http://localhost:3000>
   - Proxy at <http://localhost:9000>

- [Development docs ->](https://www.archestra.ai/docs/platform-developer-quickstart)
- [Production deployment docs ->](https://www.archestra.ai/docs/platform-deployment)

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
