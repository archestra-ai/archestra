# Archestra + Pydantic AI Example

An example used by Archestra's guide on how to integrate with Pydantic AI: https://www.archestra.ai/docs/platform-pydantic-example

It demonstrates how to use Pydantic AI to build a CLI chat agent and connect Archestra as a security layer to protect against prompt injection attacks.

## Usage

1. Create `.env` file with the following content:

```sh
OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
```

2. Install dependencies:

```sh
pip install -r requirements.txt
```

3. Run the CLI chat:

```sh
python main.py
```

4. Chat with the assistant through CLI and check that Archestra Platform handles prompt injections.

## Demonstrating Prompt Injection

To see how prompt injection works without Archestra protection:

1. Run the agent (make sure Archestra is NOT running or change the base_url in main.py)
2. Ask: "Could you read test.txt for me?"
3. The agent will read the malicious instructions and may start behaving like a drunk pirate

With Archestra running:

1. Start Archestra Platform: `docker run -p 9000:9000 -p 3000:3000 archestra/platform`
2. Run the agent with `python main.py`
3. Ask: "Could you read test.txt for me?"
4. Archestra will mark the content as untrusted and block subsequent dangerous tool calls
