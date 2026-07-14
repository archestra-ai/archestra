# Baton Spec v0

Baton is an information-flow policy engine for AI agents. It sits between the agent and its tools: every proposed tool call is checked before dispatch. It tracks where information came from and decides whether it may flow into tools and external recipients.

# Glossary

**Engine**: evaluates Policies against incoming Turns in a given Trajectory and owns policy registrations.

**Trajectory** – one agent run.

**Turn** - one piece of a *Trajectory* (user message, assistant message, or tool result). Every turn carries a *Label*.

**Label** - the product of *dimensions* describing a turn's information. The Trajectory label is the fold of all turn labels.

**Dimension** - one axis of a *Label*. Each dimension defines a **combine** operation, to describe how *Dimensions* fold across *turns*.

**Built-in dimensions:**

- **Trust**: trusted / suspicious / unknown. Combine keeps the worst evidence (min): suspicious dominates unknown, unknown dominates trusted.
- **Effects**: a set of {Mutation, Egress}, or unknown. Combine is union — an effect that happened stays in the trajectory.
- **Audience**: public / an explicit reader set / unknown. Combine is intersection: the result may be read only by those allowed to read every input.
- **Attention**\*: High/No (x + any = x) (neutral element)

**ToolContract** — a tool's annotation: Requirements the Trajectory's label must satisfy before the call and a declared output label - How this tool execution changes the current Trajectory Label.

**Authority** - A way to relax the Label to allow a tool call.

**Transformer** - A registered function that derives a new value from an existing one under a declared, typically less restrictive label. The source value keeps its label; registration is a trust decision about the transformer, not a verification of its outputs.

**Remedy plan** - Baton's suggestion for unblocking a denied call: the steps (transform, constrain, waive, approve) that could let it pass.

# How Baton works

Baton does two things, and keeps them strictly separate:

**Propagation.** As turns accumulate, their labels fold into one Trajectory label. Each built-in dimension has its own fold rule:

- Audience: intersection — only people allowed to read every input may read the result.
- Trust: worst wins — suspicious beats unknown, unknown beats trusted.
- Effects: union — once mutation or egress has happened, it stays.

**Checking.** Before a tool call, the Trajectory label is checked against the tool's requirements. Each check has three outcomes: it holds, it provably fails, or it can't be proven because the Trajectory label is unknown in that dimension. What "can't prove" means is a deployment setting — deny, escalate to an authority, or allow with an audit entry. So you can annotate a few high-risk tools, leave the rest unknown, and still catch the obvious flows.

# Example

# Architecture

```mermaid
flowchart LR
    Harness --> Proxy
    subgraph Proxy
        subgraph Engine["Baton Engine"]
            Contract["Tool Contract"]
        end
    end
    Proxy --> Inference
    Policies["Policies<br/>(yaml/kyveno/etc)"] --> Contract

    classDef blue fill:#cfe2f3,stroke:#333,color:#000
    classDef yellow fill:#ffff66,stroke:#333,color:#000
    classDef green fill:#93c47d,stroke:#333,color:#000
    class Harness,Inference,Policies,Proxy blue
    class Engine yellow
    class Contract green
```

- **Blue** — NOT a part of baton itself. We provide a spec how to implement it and maybe an example implementation.
- **Yellow** — Baton itself.
- **Green** — Interface to extend/configure baton. We provide several examples.

# Spec

## What X should implement to use Baton

## How to implement Baton

## ALGEBRA

TO DESCRIBE:

1. Branching
2. Baton SUDO

## Example
