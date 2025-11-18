---
title: Profiles
category: Archestra Platform
subcategory: Concepts
order: 1
description: Understanding and configuring profiles in Archestra Platform
lastUpdated: 2025-10-17
---

Profiles are the core concept in Archestra Platform. Each profile represents a distinct AI application or workflow that you want to secure and monitor. Think of a profile as a logical grouping for:

- **Interaction history** - All LLM requests and responses
- **Tool configurations** - Which tools the profile has access to
- **Security policies** - Tool invocation and trusted data policies specific to this profile
- **Analytics** - Performance metrics and security events

## Why Use Profiles?

Using profiles provides several benefits:

1. **Isolation** - Keep different AI applications separate with their own policies
2. **Monitoring** - Track interactions and security events per application
3. **Flexibility** - Apply different security rules to different use cases

## Profile Labels

Profile labels are a powerful feature that can be used to organize and categorize your profiles.

Beyond organization, labels also play a crucial role in observability. Read more about how to use labels for observability [here](/docs/platform-observability).
