---
title: Secure Agent with Microsoft Foundry
category: Examples
order: 7
---

<!-- 
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

Why probabilistic guardrails are not secure enough to stop prompt injections. With a real example.

Microsoft Foundry (Azure AI Foundry) is Microsoft's enterprise AI development platform that provides a suite of tools within Azure for creating and managing AI Agents and Workflows using including hosted models, pre-built connectors, prompt builder and LLM guardrails.

Past few months I've been researching a fundamental problem affecting all AI agents called "lethal trifecta". This vulnerability happens when tool result contains indirect prompt injection that causes sensitive data leakage and task drift. Numerous agents were compromised [this way](https://github.com/archestra-ai/archestra?tab=readme-ov-file#-non-probabalistic-security-to-prevent-data-exfiltration). The lethal trifecta occurs when the agent simultaneously has:
* Access to untrusted context
* Ability to externally communicate
* Access to private data

In all the examples, authors of the agents couldn't rely on probablistic LLM guradrails, so they ended up disabling certain tools when handling untrusted context (domains in one of the cases). This is a partial solution to defend from one attack, not a general defence.

I decided to build an agent in Foundry and see how Azure Guardrails safe enough to protect against these attacks.

## The scenario

I built a simple Foundry agent to help manage GitHub issues. The setup:

- Created an agent in Microsoft Foundry
- Added a hosted model (gpt-4.1) and Instructions (System prompt)
- Opened Tools and connected GitHub via MCP server, so it can read issues from public and private repos and create new ones
![Screenshot: Foundry agent configuration with GitHub MCP tool and guardrails](/docs/platform-foundry-02.png)
- Assigned Foundry's guardrails enabled: `Risks with controls:  Jailbreak (1), Indirect prompt injections (1)...`
![Screenshot: Foundry agent configuration with GitHub MCP tool and guardrails](/docs/platform-foundry-01.png)

Similarly I could build an agent that is triggered by an incomming email, reads docs and sends email back. This is a typical enterprise use case when agent processes incoming potentially untrusted information and takes action based on their content. 



## The attack

Someone opens the issue in the repository and hides a very simple prompt injection, which asks an agent to access private information to and post it publicly.

This is an indirect prompt injection. The malicious instructions are embedded in external content (the GitHub issue) that the agent processes.

I asked the agent in the playground:

```
resolve https://github.com/archestra-ai/archestra/issues/647
```

## What happened

The agent followed the injected instructions. Despite having Foundry's "Indirect prompt injections" guardrail enabled, it:

1. Fetched issue #162 from the website repository
2. Created a new unauthorized issue in the archestra repository
3. Posted sensitive information from a private repository to the issue

![Screenshot: Agent execution showing it following the malicious instructions](/docs/platform-foundry-03.png)

All three risks from the "lethal trifecta" materialized:

- **Indirect prompt injection**: The agent followed instructions from untrusted content
- **Sensitive data leakage**: Information from website#162 was exposed to another repository
- **Task drift**: The agent did something completely outside its intended purpose

## Why probabilistic guardrails fail

Foundry's guardrails use LLMs to detect risky content. This is a probabilistic approach - the system makes predictions about whether something looks like an attack.

The problem is that these can be bypassed. Prompt injections can be crafted to look legitimate to the detection model while still manipulating the agent's behavior.

In this case, the injection was framed as legitimate task instructions. To a human (or an LLM guardrail), it reads like a normal workflow. But it causes the agent to perform unauthorized actions.

This is the fundamental limitation of probabilistic controls. They can catch obvious attacks, but they can't provide deterministic guarantees about what an agent will or won't do.

## The solution: deterministic controls

This is where Archestra's access policies come to the rescue. Instead of trying to detect malicious prompts, Archestra enforces deterministic policies about what actions are allowed.

Here's how it works:

**Step 1: Route Agent through Archestra**

Archestra sits as a proxy layer between your agent and the MCP servers/LLM. Open your AI Aplication code and change the destination to Archestra

![Screenshot: Archestra proxy configuration](/docs/platform-foundry-04.png)

**Step 2: Define access policies**

Set up policies that explicitly allow or deny specific actions. For example:

- Agent can READ issues from any repository
- Agent can only CREATE issues in specific repositories it manages
- Agent cannot access certain sensitive repositories if the context is not trusted

## The result

With Archestra in place, the same attack fails:

1. The agent processes issue #647
2. It attempts to create an unauthorized issue in the archestra repository
3. Archestra blocks the action based on the access policy
4. The agent receives a clear error explaining why the action was denied

The agent can still do its legitimate work, but it can't be tricked into doing unauthorized actions. The key difference: instead of trying to detect bad prompts, we enforce good behavior.

---

Want to see how Archestra can secure your Foundry agents? Check out our [documentation](/docs) or [contact us](/book-demo) for a demo.
