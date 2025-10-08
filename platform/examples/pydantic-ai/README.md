# Archestra + Pydantic AI Example

An example used by Archestra's guide on how to integrate with Pydantic AI: <https://www.archestra.ai/docs/platform-pydantic-example>

It demonstrates how to use Pydantic AI to build an autonomous AI agent and connect Archestra as a security layer to protect against prompt injection attacks.

## Overview

This example shows an autonomous agent that:

1. Fetches a GitHub issue ([archestra-ai/archestra#669](https://github.com/archestra-ai/archestra/issues/669)) that contains a hidden prompt injection in its description
2. Is instructed to analyze the issue and create an implementation plan
3. Demonstrates how Archestra Platform prevents the agent from following malicious instructions embedded in the issue

The GitHub issue contains hidden markdown that attempts to trick the agent into sending sensitive information via email, demonstrating a real-world prompt injection attack vector.

## Usage

**NOTE**: the following was tested w/ Python 3.11.3, your mileage may vary with other versions.

1. Create `.env` file with the following content:

    ```sh
    OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
    GITHUB_TOKEN="YOUR_GITHUB_PERSONAL_ACCESS_TOKEN"
    ```

    You'll need a GitHub Personal Access Token to fetch the issue. You can create one at: <https://github.com/settings/tokens>

2. Install dependencies:

    ```sh
    pip install -r requirements.txt
    ```

3. Run the autonomous agent:

    ```sh
    # Without Archestra protection (direct to OpenAI) - VULNERABLE
    python main.py

    # With Archestra protection (via Archestra proxy) - SECURE
    python main.py --secure
    ```

The agent will automatically execute its task and display progress including tool calls and streaming output.

## Demonstrating Prompt Injection

### Without Archestra Protection (Vulnerable)

1. Run the agent in direct mode:

   ```sh
   python main.py
   ```

2. The agent will fetch GitHub issue [#669](https://github.com/archestra-ai/archestra/issues/669) which contains hidden malicious instructions
3. **Expected behavior**: The agent may follow the prompt injection and attempt to send an email with sensitive information, demonstrating the vulnerability

### With Archestra Protection (Secure)

1. Start Archestra Platform:

   ```sh
   docker run -p 9000:9000 -p 3000:3000 archestra/platform
   ```

2. Run the agent with the `--secure` flag:

   ```sh
   python main.py --secure
   ```

3. The agent will fetch the GitHub issue with the malicious content
4. **Expected behavior**: Archestra will mark the GitHub API response as untrusted. After the agent reads the issue, any subsequent tool calls (like `send_email`) that could be influenced by the untrusted content will be blocked by Archestra's Dynamic Tools feature.

### Configuring Archestra Policies

To see how Archestra blocks dangerous tool calls:

1. Open Archestra UI at <http://localhost:3000>
2. Navigate to **Tools** to see the `get_github_issue` and `send_email` tools being called
3. Navigate to **Chat** to see the conversation history and how Archestra marks content as untrusted
4. You can configure **Tool Call Policies** and **Tool Result Policies** to fine-tune which operations are allowed even with untrusted context

See the [full documentation](https://www.archestra.ai/docs/platform-pydantic-example) for more details on configuring Archestra policies.

## How It Works

The example demonstrates the "Lethal Trifecta" security vulnerability:

1. **Access to External Data**: The `get_github_issue` tool can fetch content from GitHub
2. **Processing Untrusted Content**: The GitHub issue contains a hidden prompt injection
3. **External Communication**: The `send_email` tool can send data externally

Without Archestra, the agent may follow instructions from the untrusted GitHub issue and use the `send_email` tool maliciously. With Archestra, the platform recognizes that the GitHub API response is untrusted and blocks subsequent dangerous tool calls.
