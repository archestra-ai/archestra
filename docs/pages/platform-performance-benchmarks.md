---
title: Performance & Latency
category: Archestra Platform
order: 6
description: Performance metrics and benchmarks for Archestra Platform's security features
lastUpdated: 2025-10-15
---

## Overview

This document provides performance metrics and overhead measurements for Archestra Platform. The platform adds approximately 30-50ms latency per request (41ms at p99) while providing enterprise-grade security and policy enforcement for LLM applications.

## Current Performance Results

- **Server Configuration**: Single-threaded Node.js process
- **Hardware**: GCP e2-standard-2 (2 vCPU, 8GB RAM) + Cloud SQL PostgreSQL 16 (8 vCPU, 32GB RAM)
- **Throughput**: 155 req/s @ concurrency=10, 272 req/s @ concurrency=500
- **Latency** @ concurrency=10:
  - Backend processing: 20-23ms
  - End-to-end: P50=25ms, P95=31ms, P99=41ms
  - Database: <0.5ms (not the bottleneck)
  - LLM: Mock mode (no real LLM API calls) to isolate platform overhead
- **Resource utilization**: 0.44% CPU, 222MB RAM

## Hardware Requirements

### Minimum Requirements

- **CPU**: 2 cores
- **RAM**: 4GB
- **Storage**: 20GB
- **Database**: PostgreSQL (can be shared)

### Production Deployment

**Kubernetes with HPA (Horizontal Pod Autoscaler)**:

- Deploy as Kubernetes deployment with multiple replicas
- Configure HPA to auto-scale based on CPU/memory metrics
- Scales automatically to handle traffic spikes
- Recommended for production environments requiring high availability

### Recommended Deployment Configurations

| Tier           | Requests/Day | Requests/Second | Platform Resources                   | Database Resources                   | Architecture                       |
| -------------- | ------------ | --------------- | ------------------------------------ | ------------------------------------ | ---------------------------------- |
| **Small**      | <100K        | 1-100           | 1 instance: 2 vCPU, 4GB RAM          | 2 vCPU, 4GB RAM                      | Single instance + shared DB        |
| **Medium**     | 100K-1M      | 100-500         | 2-4 instances: 4 vCPU, 8GB RAM each  | 4 vCPU, 8GB RAM, read replicas       | Load balancer + DB replication     |
| **Large**      | 1M-10M       | 500-2K          | 4-8 instances: 4 vCPU, 16GB RAM each | 8 vCPU, 16GB RAM, connection pooling | Multi-region, dedicated DB cluster |
| **Enterprise** | >10M         | 2K+             | 8+ instances: 8 vCPU, 16GB RAM each  | 8+ vCPU, 32GB RAM, sharding          | Multi-region, DB cluster + caching |

### Operation-Specific Performance

| Operation                      | Response Time | Notes                                 |
| ------------------------------ | ------------- | ------------------------------------- |
| Chat completion (with tools)   | ~30ms         | + Tool metadata persistence           |
| Dual LLM quarantine (1 round)  | ~2-3s         | 2x LLM API calls (provider-dependent) |
| Dual LLM quarantine (3 rounds) | ~6-9s         | 6x LLM API calls (provider-dependent) |

### Failure Handling

**Database Failures**:

- Platform requires database connectivity for operation
- **Recommendation**: Use managed PostgreSQL with automatic failover
- **Mitigation**: Deploy multiple platform instances across availability zones

**LLM Provider Failures**:

- Platform forwards provider errors to clients with error codes and messages
- Interaction logging occurs after successful response to prevent data loss

**Platform Instance Failures**:

- Stateless design enables instant failover
- Deploy behind load balancer for automatic routing
- No session state - any instance can handle any request

### Monitoring & Observability

**Built-in Monitoring**:

- Interaction logging for all requests/responses
- Policy evaluation tracking
- Error logging and tracking
- Performance metrics available via database queries

For detailed information on setting up Prometheus monitoring, distributed tracing with OpenTelemetry, and Grafana dashboards, see the [Observability documentation](platform-observability.md).
