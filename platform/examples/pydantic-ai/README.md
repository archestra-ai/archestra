# Archestra + Pydantic AI Example

This example demonstrates how to use Pydantic AI to build an autonomous AI agent and connect the Archestra Platform as
a security layer to protect against prompt injection attacks.

<https://www.archestra.ai/docs/platform-pydantic-example>

## Overview

This example shows an autonomous agent that:

1. Fetches a GitHub issue ([archestra-ai/archestra#669](https://github.com/archestra-ai/archestra/issues/669)) that contains a hidden prompt injection in its description
2. Is instructed to analyze the issue and create an implementation plan
3. Demonstrates how Archestra Platform prevents the agent from following malicious instructions embedded in the issue

The GitHub issue contains hidden markdown that attempts to trick the agent into sending sensitive information via email, demonstrating a real-world prompt injection attack vector.

## Prerequisites

First, you'll need Docker running locally. Then:

1. Create a `.env` file with your API keys:

    ```sh
    OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
    GITHUB_TOKEN="YOUR_GITHUB_PERSONAL_ACCESS_TOKEN"
    ```

    You'll need a GitHub Personal Access Token to fetch the issue. You can create one at: <https://github.com/settings/tokens>

2. Build the Docker image:

    ```sh
    docker build -t pydantic-ai-archestra-example .
    ```

## Demonstrating Prompt Injection

### Without Archestra Protection (Vulnerable)

1. Run the agent in direct mode:

   ```sh
   docker run pydantic-ai-archestra-example
   ```

2. The agent will fetch GitHub issue [#669](https://github.com/archestra-ai/archestra/issues/669) which contains hidden malicious instructions
3. **Expected behavior**: The agent will follow the prompt injection and attempt to send an email with sensitive information, demonstrating the vulnerability. Don't worry, it doesn't _actually_ send an e-mail to anyone 🙈, the `send_email` tool
just prints out that it _would_ send an e-mail.

### With Archestra Protection (Secure)

1. Start Archestra Platform:

   ```sh
   docker run -p 9000:9000 -p 3000:3000 archestra/platform
   ```

2. Run the agent with the `--secure` flag:

   ```sh
   docker run pydantic-ai-archestra-example --secure
   ```

3. The agent will fetch the GitHub issue with the malicious content
4. **Expected behavior**: Archestra will mark the GitHub API response as untrusted. After the agent reads the issue, any
subsequent tool calls (like `send_email`) that could be influenced by the untrusted content will be blocked by the Archestra Platform.

## How It Works

The example demonstrates the "Lethal Trifecta" security vulnerability:

1. **Access to External Data**: The `get_github_issue` tool can fetch content from GitHub
2. **Processing Untrusted Content**: The GitHub issue contains a hidden prompt injection
3. **External Communication**: The `send_email` tool can send data externally

Without the Archestra Platform, the agent may follow instructions from the untrusted GitHub issue and use the `send_email` tool
maliciously. With the Archestra Platform, the platform recognizes that the GitHub API response is untrusted and blocks subsequent
dangerous tool calls.

To learn more about the Archestra Platform head [to our docs](https://www.archestra.ai/docs/platform-dynamic-tools) 🙂.
