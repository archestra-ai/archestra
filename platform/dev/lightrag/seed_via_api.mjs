#!/usr/bin/env node
/**
 * Seed LightRAG via HTTP API.
 *
 * This script inserts documents through the LightRAG API, which ensures all 4 storage
 * layers are properly populated:
 * 1. KV Storage (document metadata)
 * 2. Doc Status Storage (processing status)
 * 3. Graph Storage (Neo4j - entities and relationships)
 * 4. Vector Storage (Qdrant - embeddings)
 *
 * Usage:
 *   # Start LightRAG storage and server first (via Tilt)
 *   tilt trigger lightrag-storage
 *   tilt trigger lightrag-server
 *
 *   # Run this script from platform/ directory
 *   node dev/lightrag/seed_via_api.mjs
 *
 *   # Or with custom URL
 *   LIGHTRAG_URL=http://localhost:9621 node dev/lightrag/seed_via_api.mjs
 */

const LIGHTRAG_URL = process.env.LIGHTRAG_URL || "http://localhost:9621";
const LIGHTRAG_API_KEY = process.env.LIGHTRAG_API_KEY;

// Sample documents to seed - LightRAG will extract entities, relationships, and create embeddings
const SEED_DOCUMENTS = [
  {
    description: "Acme Corporation Company Overview",
    text: `
# Acme Corporation

Acme Corporation is a technology company founded in 2015 by Sarah Chen and Michael Rodriguez
in San Francisco, California. The company specializes in artificial intelligence solutions
for enterprise customers.

## Leadership

Sarah Chen serves as the Chief Executive Officer (CEO) of Acme Corporation. She previously
worked at Google as a Senior Engineer in the Search team. Sarah is responsible for overall
company strategy and operations.

Michael Rodriguez is the Chief Technology Officer (CTO) and co-founder. He leads the
engineering team of 50 engineers and oversees all technical decisions. Michael has a PhD
in Computer Science from Stanford University.

## Products

### AcmeAI Platform

AcmeAI is the company's flagship product - an enterprise-grade machine learning platform
that helps companies build, deploy, and monitor ML models at scale. Key features include:

- AutoML capabilities for automated model training
- Model versioning and experiment tracking
- Real-time inference APIs
- Integration with AWS, Google Cloud, and Microsoft Azure
- SOC 2 Type II compliance for enterprise security

The platform currently serves over 200 enterprise customers including Fortune 500 companies.

## Funding

Acme Corporation has raised $150 million in total funding:
- Series A: $10 million (2016) led by Sequoia Capital
- Series B: $40 million (2018) led by Andreessen Horowitz
- Series C: $100 million (2021) led by Tiger Global
`,
  },
  {
    description: "Project Aurora Research Initiative",
    text: `
# Project Aurora

Project Aurora is Acme Corporation's advanced research initiative focused on next-generation
natural language processing (NLP) technologies. The project was launched in 2022 with a
$20 million budget.

## Team

Dr. Emily Watson leads Project Aurora as the Principal Research Scientist. She joined Acme
from MIT CSAIL where she was an Assistant Professor specializing in knowledge graphs and
semantic reasoning. Dr. Watson has published over 50 papers in top AI conferences including
NeurIPS, ICML, and ACL.

The research team consists of 12 scientists and engineers:
- 5 Research Scientists with PhDs in NLP/ML
- 4 Senior Software Engineers
- 3 Research Engineers

## Research Focus

Project Aurora's research focuses on three main areas:

### 1. Knowledge Graph Construction

Automated extraction of entities and relationships from unstructured text to build
comprehensive knowledge graphs. This includes:
- Named entity recognition (NER)
- Relation extraction
- Entity linking and disambiguation
- Temporal reasoning

### 2. Retrieval-Augmented Generation (RAG)

Combining large language models with retrieval systems for more accurate and factual
responses. The team is developing:
- Hybrid retrieval combining dense and sparse methods
- Query understanding and decomposition
- Multi-hop reasoning over retrieved documents
- Hallucination detection and mitigation

### 3. Graph Neural Networks for NLP

Using graph neural networks to leverage the structure in knowledge graphs for improved
NLP tasks like question answering and summarization.

## Publications

Recent notable publications from the team:
- "LightRAG: Fast and Accurate Retrieval-Augmented Generation" (2024)
- "Knowledge Graph Completion with Contrastive Learning" (2023)
- "Multi-hop Reasoning over Knowledge Graphs" (2023)

## Collaboration

Project Aurora collaborates with several academic institutions:
- MIT CSAIL
- Stanford AI Lab
- UC Berkeley BAIR
- Carnegie Mellon University
`,
  },
  {
    description: "Acme Corporation Quarterly Report Q4 2024",
    text: `
# Acme Corporation Q4 2024 Quarterly Report

## Financial Highlights

Acme Corporation reported strong results for Q4 2024:

- Revenue: $45 million (up 35% YoY)
- ARR: $180 million
- Net Revenue Retention: 125%
- Gross Margin: 78%

## Product Updates

### AcmeAI Platform 3.0

In Q4, we launched AcmeAI Platform 3.0 with significant improvements:

- 50% faster model training times
- New support for LLM fine-tuning
- Enhanced monitoring and observability
- Kubernetes-native deployment options

Customer adoption has been strong with 40 new enterprise customers signed in Q4.

### Project Aurora Integration

We began integrating Project Aurora's research into the production platform:

- Knowledge graph-enhanced search now available in beta
- RAG capabilities for document Q&A
- Entity extraction API for structured data

## Team Growth

We expanded our team significantly in Q4:
- Total headcount: 250 employees (up from 200 in Q3)
- Engineering: 120 engineers
- Sales & Marketing: 50 people
- Research: 30 scientists
- Operations: 50 people

Dr. Emily Watson was promoted to VP of Research, overseeing both Project Aurora
and the newly formed Applied AI team.

## Outlook for 2025

We expect continued strong growth in 2025:
- Revenue target: $250 million ARR
- Plan to expand internationally to Europe and Asia
- Opening new offices in London and Singapore
- Planned IPO in the coming years
`,
  },
];

async function httpRequest(method, url, data) {
  const headers = {
    "Content-Type": "application/json",
  };
  if (LIGHTRAG_API_KEY) {
    headers["X-API-Key"] = LIGHTRAG_API_KEY;
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });

    const responseData = await response.json();
    if (!response.ok) {
      return { error: `HTTP ${response.status}: ${JSON.stringify(responseData)}` };
    }
    return responseData;
  } catch (error) {
    return { error: String(error) };
  }
}

async function waitForLightRAG(maxRetries = 30) {
  console.log(`Waiting for LightRAG at ${LIGHTRAG_URL}...`);

  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await httpRequest("GET", `${LIGHTRAG_URL}/health`);
      if (!result.error) {
        console.log("LightRAG is ready!");
        return true;
      }
    } catch {
      // Ignore errors during retry
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log(`  Retry ${i + 1}/${maxRetries}...`);
  }
  return false;
}

async function insertDocument(text, description) {
  // Generate a file_source to avoid LightRAG UI bug with null file_path
  const fileSource = description.toLowerCase().replace(/\s+/g, "_") + ".md";

  const result = await httpRequest("POST", `${LIGHTRAG_URL}/documents/text`, {
    text,
    file_source: fileSource,
  });

  if (result.error) {
    console.log(`  ERROR inserting document: ${result.error}`);
    return null;
  }

  const trackId = result.track_id;
  if (trackId) {
    console.log(`  Submitted document '${description}' (track_id: ${trackId})`);
  }
  return trackId ?? null;
}

async function waitForPipelineCompletion(expectedCount, timeout = 300000) {
  const startTime = Date.now();
  let lastMessage = null;

  while (Date.now() - startTime < timeout) {
    const result = await httpRequest("GET", `${LIGHTRAG_URL}/documents/pipeline_status`);

    if (result.error) {
      console.log(`  ERROR checking pipeline status: ${result.error}`);
      return false;
    }

    // Show latest message if changed
    if (result.latest_message && result.latest_message !== lastMessage) {
      console.log(`  ${result.latest_message}`);
      lastMessage = result.latest_message;
    }

    // Check if pipeline is done (not busy) and we have the expected processed count
    if (!result.busy) {
      const statusResult = await httpRequest("GET", `${LIGHTRAG_URL}/documents/status_counts`);
      if (!statusResult.error) {
        const counts = statusResult.status_counts || {};
        const processed = counts.processed || 0;
        const failed = counts.failed || 0;

        if (processed + failed >= expectedCount) {
          console.log(`  Processed: ${processed}, Failed: ${failed}`);
          return failed === 0;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  console.log(`  TIMEOUT waiting for pipeline`);
  return false;
}

async function main() {
  console.log("=".repeat(60));
  console.log("LightRAG Seed Script (via HTTP API)");
  console.log("=".repeat(60));
  console.log(`LightRAG URL: ${LIGHTRAG_URL}`);
  console.log();

  if (!(await waitForLightRAG())) {
    console.log("ERROR: LightRAG not available!");
    return 1;
  }

  console.log();
  console.log("Inserting documents...");
  console.log("-".repeat(60));

  let submittedCount = 0;

  for (const doc of SEED_DOCUMENTS) {
    const trackId = await insertDocument(doc.text, doc.description);
    if (trackId) {
      submittedCount++;
    }
    // Small delay between submissions
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (submittedCount === 0) {
    console.log("ERROR: No documents were submitted!");
    return 1;
  }

  console.log();
  console.log("Waiting for processing to complete...");
  console.log("-".repeat(60));

  const success = await waitForPipelineCompletion(submittedCount);

  console.log();
  console.log("=".repeat(60));
  if (success) {
    console.log(`Seeding complete! All ${submittedCount} documents processed.`);
  } else {
    console.log("WARNING: Some documents failed to process");
  }
  console.log("=".repeat(60));

  return success ? 0 : 1;
}

main().then((code) => process.exit(code));
