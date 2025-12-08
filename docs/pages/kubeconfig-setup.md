---
title: Kubeconfig Setup
category: Archestra Platform
subcategory: Deployment
order: 3
---

# Kubeconfig Setup

This guide explains how to configure a kubeconfig file for the Archestra MCP Orchestrator, how the platform reads it, and how to resolve common errors.

## What is a Kubeconfig?

A kubeconfig file tells Kubernetes tools how to connect to a cluster.

It defines:

clusters — where the Kubernetes API is located

users — the credentials used to authenticate

contexts — a named pairing of a cluster + user

Archestra's MCP Orchestrator uses this file to talk to your Kubernetes cluster.

## Environment Variables

The orchestrator reads kubeconfig using the following variables:

# Path to your kubeconfig file
# If not provided, the system automatically falls back to the OS default (~/.kube/config)
ARCHESTRA_ORCHESTRATOR_KUBECONFIG=/path/to/kubeconfig

# Set to true when Archestra is running *inside* a Kubernetes Pod
# This bypasses kubeconfig and uses the in-cluster API instead
ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER=false

## Default Behavior (Important)

If ARCHESTRA_ORCHESTRATOR_KUBECONFIG is not set:

Archestra does not validate the kubeconfig

It simply loads the default file used by kubectl:

OS	Default location
Windows	%USERPROFILE%\.kube\config
macOS	~/.kube/config
Linux	~/.kube/config

This ensures the backend still boots normally, even if no custom kubeconfig is provided.

Validation happens only when you explicitly set the kubeconfig path.

## How to Get a Kubeconfig

### Docker Desktop

Open Docker Desktop

Go to Settings → Kubernetes

Enable Kubernetes

Click Copy kubeconfig, or use the default:

Windows: %USERPROFILE%\.kube\config

macOS/Linux: ~/.kube/config

### Kind (Kubernetes-in-Docker)

```bash
kind create cluster --name my-cluster
kind export kubeconfig --name my-cluster
```

The kubeconfig now lives at ~/.kube/config.

### Minikube

```bash
minikube start
minikube kubeconfig
```

If needed:

```bash
cp $(minikube kubeconfig) /path/to/custom/kubeconfig
```

## What a Valid Kubeconfig Must Contain

When you manually set ARCHESTRA_ORCHESTRATOR_KUBECONFIG, the file must include the following structure:

apiVersion: v1
clusters:
- name: <cluster-name>
  cluster:
    server: https://<endpoint>

contexts:
- name: <context-name>
  context:
    cluster: <cluster-name>
    user: <user-name>

users:
- name: <user-name>
  user:
    token: <token>   # or certificate-based auth

current-context: <context-name>


Archestra checks these sections only for manually provided configs.

## Common Errors & How to Fix Them
❌ "No kubeconfig path or content provided"

You set the env variable but didn’t give a file.

Fix:

export ARCHESTRA_ORCHESTRATOR_KUBECONFIG=/path/to/kubeconfig


—or simply remove it:

unset ARCHESTRA_ORCHESTRATOR_KUBECONFIG

❌ "Kubeconfig file not found"

The file path doesn’t exist.

Fix:

Double-check the path

Ensure permissions are correct

On Windows, escape backslashes if needed

❌ "Malformed kubeconfig: unable to parse file"

Usually caused by:

Incorrect indentation

Broken YAML

Corrupted base64 certificate fields

Windows newline or BOM issues

Fix:

Validate your file using a YAML checker

Re-export kubeconfig from Docker Desktop / Minikube / Kind

❌ "Invalid kubeconfig: 'clusters' section missing"

Add:

clusters:
- name: my-cluster
  cluster:
    server: https://endpoint

❌ "clusters[0] is missing required fields"

Ensure both name and cluster.server exist:

clusters:
- name: my-cluster
  cluster:
    server: https://endpoint

❌ "'contexts' section missing"

Add:

contexts:
- name: my-context
  context:
    cluster: my-cluster
    user: my-user

❌ "'users' section missing"

Add:

users:
- name: my-user
  user:
    token: <token>

## Example of a Valid Kubeconfig
apiVersion: v1
clusters:
- name: my-cluster
  cluster:
    server: https://your-cluster.example.com:6443

contexts:
- name: my-context
  context:
    cluster: my-cluster
    user: my-user

users:
- name: my-user
  user:
    token: <token>

current-context: my-context
kind: Config
preferences: {}

## Examples of Invalid Kubeconfigs

### Missing clusters:

```yaml
apiVersion: v1
contexts: []
users: []
```

### Missing cluster.server:

```yaml
clusters:
- name: my-cluster
  cluster: {}
```

### Invalid YAML:

```yaml
contexts:
  context:
    cluster: x
    user: y
```

## Test Your Kubeconfig

```bash
kubectl --kubeconfig=/path/to/kubeconfig cluster-info
kubectl --kubeconfig=/path/to/kubeconfig get nodes
kubectl --kubeconfig=/path/to/kubeconfig get pods -A --limit=1
```

## Troubleshooting Checklist

File permissions:

```bash
chmod 600 ~/.kube/config
```

Ensure your token/certificate is valid

Verify that your cluster endpoint is reachable

Make sure current-context references an existing context

Check Archestra backend logs for detailed validation messages
