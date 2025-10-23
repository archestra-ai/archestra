# Archestra Enterprise MCP Gateway

A central place for teams and enterprises to manage MCP and agents at scale.
- MCP Gateway
- LLM Gateway
- Guardrails preventing "The Lethal Trifecta"
- Private MCP Registry
- MCP Orchestrator
- Lightweight & efficient
- Role-Based-Access-Control for multi-team usage
- Metrics exporter

<div align="center">

<div align="center">
<img src="/docs/assets/archestra.png" alt="Trifecta" />
</div>

[![License](https://img.shields.io/github/license/archestra-ai/archestra)](LICENSE)
<img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/archestra-ai/archestra"/>
<img alt="Github Last Commit" src="https://img.shields.io/github/last-commit/archestra-ai/archestra"/>
[![Contributors](https://img.shields.io/github/contributors/archestra-ai/archestra)](https://github.com/archestra-ai/archestra/graphs/contributors)

<p align="center">
  <a href="https://www.archestra.ai/docs/platfrom-quickstart">Getting Started</a>
  - <a href="https://github.com/archestra-ai/archestra/releases">Releases</a>
  - <a href="https://github.com/archestra-ai/archestra/issues">Bug reports</a>
  - <a href="https://join.slack.com/t/archestracommunity/shared_invite/zt-39yk4skox-zBF1NoJ9u4t59OU8XxQChg">Slack Commuity</a>
</p>
</div>

## Quickstart

1. Start with Docker

   ```bash
   docker run -p 9000:9000 -p 3000:3000 archestra/platform
   ```

2. Open <http://localhost:3000>

3. The platform is now running with:
   - Web UI at <http://localhost:3000>
   - Proxy at <http://localhost:9000>

- [Development docs ->](https://www.archestra.ai/docs/platfrom-developer-quickstart)
- [Production deployment docs ->](https://www.archestra.ai/docs/platform-deployment)

# Archestra mitigates "The Lethal Trifecta"

[Simon Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/), [The Economist](https://www.economist.com/leaders/2025/09/25/how-to-stop-ais-lethal-trifecta)

[![Archestra Demo](https://img.youtube.com/vi/SkmluS-xzmM/0.jpg)](https://www.youtube.com/watch?v=SkmluS-xzmM&t=2155s)

The "lethal trifecta" for AI agents is a critical security vulnerability that arises from combining three specific capabilities: access to private data, exposure to untrusted content, and the ability to communicate externally. An attacker can exploit this combination by embedding malicious instructions within untrusted content, such as a webpage or email. Because LLMs follow any instructions they are given, they can be tricked into accessing your private data and sending it to the attacker. This creates a significant security risk, as the LLM cannot distinguish between user commands and malicious instructions embedded in the content it processes.

<div align="center">
<img src="/docs/assets/trifecta.png" alt="Trifecta" />
</div>

Examples of hacks:
[ChatGPT](https://simonwillison.net/2023/Apr/14/new-prompt-injection-attack-on-chatgpt-web-version-markdown-imag/) (April 2023), [ChatGPT Plugins](https://simonwillison.net/2023/May/19/chatgpt-prompt-injection/) (May 2023), [Google Bard](https://simonwillison.net/2023/Nov/4/hacking-google-bard-from-prompt-injection-to-data-exfiltration/) (November 2023), [Writer.com](https://simonwillison.net/2023/Dec/15/writercom-indirect-prompt-injection/) (December 2023), [Amazon Q](https://simonwillison.net/2024/Jan/19/aws-fixes-data-exfiltration/) (January 2024), [Google NotebookLM](https://simonwillison.net/2024/Apr/16/google-notebooklm-data-exfiltration/) (April 2024), [GitHub Copilot Chat](https://simonwillison.net/2024/Jun/16/github-copilot-chat-prompt-injection/) (June 2024), [Google AI Studio](https://simonwillison.net/2024/Aug/7/google-ai-studio-data-exfiltration-demo/) (August 2024), [Microsoft Copilot](https://simonwillison.net/2024/Aug/14/living-off-microsoft-copilot/) (August 2024), [Slack](https://simonwillison.net/2024/Aug/20/data-exfiltration-from-slack-ai/) (August 2024), [Mistral Le Chat](https://simonwillison.net/2024/Oct/22/imprompter/) (October 2024), [xAI's Grok](https://simonwillison.net/2024/Dec/16/security-probllms-in-xais-grok/) (December 2024), [Anthropic's Claude iOS app](https://simonwillison.net/2024/Dec/17/johann-rehberger/) (December 2024), [ChatGPT Operator](https://simonwillison.net/2025/Feb/17/chatgpt-operator-prompt-injection/) (February 2025), [Notion 3.0](https://www.codeintegrity.ai/blog/notion) (September 2025).

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
