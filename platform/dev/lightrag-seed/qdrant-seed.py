#!/usr/bin/env python3
"""Seed Qdrant with example vector data for LightRAG demo."""

import json
import os
import random
import ssl
import time
import urllib.request
import urllib.error

QDRANT_URL = os.environ.get("QDRANT_URL", "http://qdrant:6333")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY")
EMBEDDING_DIM = 3072  # text-embedding-3-large dimension

# LightRAG collection names
COLLECTIONS = [
    "lightrag_vdb_entities",
    "lightrag_vdb_relationships",
    "lightrag_vdb_chunks",
]

# Example entities with descriptions for semantic search
EXAMPLE_ENTITIES = [
    {
        "id": "entity_acme",
        "name": "Acme Corporation",
        "description": "Technology company specializing in artificial intelligence solutions for enterprise customers",
    },
    {
        "id": "entity_sarah",
        "name": "Sarah Chen",
        "description": "CEO of Acme Corporation, previously Senior Engineer at Google",
    },
    {
        "id": "entity_michael",
        "name": "Michael Rodriguez",
        "description": "CTO of Acme Corporation, co-founder, leads engineering team",
    },
    {
        "id": "entity_emily",
        "name": "Dr. Emily Watson",
        "description": "Research scientist leading Project Aurora, NLP and knowledge graph expert from MIT",
    },
    {
        "id": "entity_aurora",
        "name": "Project Aurora",
        "description": "Research initiative for next-generation NLP using knowledge graphs and RAG",
    },
    {
        "id": "entity_acmeai",
        "name": "AcmeAI",
        "description": "Enterprise machine learning platform for building and deploying ML models at scale",
    },
]

# Example relationships between entities
EXAMPLE_RELATIONSHIPS = [
    {
        "id": "rel_sarah_ceo",
        "source": "Sarah Chen",
        "target": "Acme Corporation",
        "relationship": "CEO_OF",
        "description": "Sarah Chen serves as the Chief Executive Officer of Acme Corporation",
    },
    {
        "id": "rel_sarah_founded",
        "source": "Sarah Chen",
        "target": "Acme Corporation",
        "relationship": "CO_FOUNDED",
        "description": "Sarah Chen co-founded Acme Corporation in 2015 in San Francisco",
    },
    {
        "id": "rel_michael_cto",
        "source": "Michael Rodriguez",
        "target": "Acme Corporation",
        "relationship": "CTO_OF",
        "description": "Michael Rodriguez serves as the Chief Technology Officer of Acme Corporation",
    },
    {
        "id": "rel_michael_founded",
        "source": "Michael Rodriguez",
        "target": "Acme Corporation",
        "relationship": "CO_FOUNDED",
        "description": "Michael Rodriguez co-founded Acme Corporation in 2015 with Sarah Chen",
    },
    {
        "id": "rel_emily_leads",
        "source": "Dr. Emily Watson",
        "target": "Project Aurora",
        "relationship": "LEADS",
        "description": "Dr. Emily Watson leads Project Aurora as the principal research scientist",
    },
    {
        "id": "rel_emily_works",
        "source": "Dr. Emily Watson",
        "target": "Acme Corporation",
        "relationship": "WORKS_AT",
        "description": "Dr. Emily Watson works at Acme Corporation as a research scientist",
    },
    {
        "id": "rel_aurora_belongs",
        "source": "Project Aurora",
        "target": "Acme Corporation",
        "relationship": "BELONGS_TO",
        "description": "Project Aurora is a research initiative belonging to Acme Corporation",
    },
    {
        "id": "rel_acmeai_product",
        "source": "AcmeAI",
        "target": "Acme Corporation",
        "relationship": "PRODUCT_OF",
        "description": "AcmeAI is the flagship product developed by Acme Corporation",
    },
    {
        "id": "rel_michael_leads_eng",
        "source": "Michael Rodriguez",
        "target": "AcmeAI",
        "relationship": "LEADS_DEVELOPMENT",
        "description": "Michael Rodriguez leads the engineering team developing AcmeAI",
    },
]

EXAMPLE_CHUNKS = [
    {
        "id": "chunk_1",
        "content": "Acme Corporation is a technology company founded in 2015 by Sarah Chen and Michael Rodriguez in San Francisco. The company specializes in artificial intelligence solutions for enterprise customers.",
        "doc_id": "example_company_overview",
    },
    {
        "id": "chunk_2",
        "content": "Sarah Chen serves as the CEO of Acme Corporation. She previously worked at Google as a Senior Engineer. Michael Rodriguez is the CTO and leads the engineering team of 50 engineers.",
        "doc_id": "example_company_overview",
    },
    {
        "id": "chunk_3",
        "content": "AcmeAI is an enterprise-grade machine learning platform that helps companies build, deploy, and monitor ML models at scale. It integrates with AWS, Google Cloud, and Microsoft Azure.",
        "doc_id": "example_company_overview",
    },
    {
        "id": "chunk_4",
        "content": "Project Aurora is Acme's research initiative for next-generation NLP. Led by Dr. Emily Watson from MIT CSAIL, the team focuses on knowledge graphs and retrieval-augmented generation.",
        "doc_id": "example_research_project",
    },
]


def generate_mock_embedding(text: str, dim: int = EMBEDDING_DIM) -> list[float]:
    """Generate a deterministic mock embedding based on text hash."""
    # Use text hash as seed for reproducibility
    seed = hash(text) % (2**32)
    random.seed(seed)
    # Generate normalized random vector
    vec = [random.gauss(0, 1) for _ in range(dim)]
    norm = sum(x**2 for x in vec) ** 0.5
    return [x / norm for x in vec]


def http_request(method: str, url: str, data: dict = None) -> dict:
    """Make HTTP request to Qdrant."""
    headers = {"Content-Type": "application/json"}
    if QDRANT_API_KEY:
        headers["api-key"] = QDRANT_API_KEY
    req = urllib.request.Request(
        url,
        method=method,
        headers=headers,
    )
    if data:
        req.data = json.dumps(data).encode("utf-8")

    try:
        ssl_context = None
        if url.startswith("https"):
            try:
                import certifi
                ssl_context = ssl.create_default_context(cafile=certifi.where())
            except ImportError:
                # Fallback if certifi not installed (less secure)
                ssl_context = ssl.create_default_context()
                ssl_context.check_hostname = False
                ssl_context.verify_mode = ssl.CERT_NONE
        with urllib.request.urlopen(req, timeout=10, context=ssl_context) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8") if e.fp else ""
        return {"error": str(e), "body": body}
    except Exception as e:
        return {"error": str(e)}


def wait_for_qdrant(max_retries: int = 30) -> bool:
    """Wait for Qdrant to be ready."""
    print("Waiting for Qdrant to be ready...")
    for i in range(max_retries):
        try:
            result = http_request("GET", f"{QDRANT_URL}/collections")
            if "error" not in result:
                print("Qdrant is ready!")
                return True
        except Exception:
            pass
        time.sleep(1)
        print(f"  Retry {i + 1}/{max_retries}...")
    return False


def create_collection(name: str) -> bool:
    """Create a Qdrant collection if it doesn't exist."""
    # Check if exists
    result = http_request("GET", f"{QDRANT_URL}/collections/{name}")
    if "error" not in result and result.get("result"):
        print(f"  Collection '{name}' already exists")
        return True

    # Create collection
    data = {
        "vectors": {
            "size": EMBEDDING_DIM,
            "distance": "Cosine",
        }
    }
    result = http_request("PUT", f"{QDRANT_URL}/collections/{name}", data)
    if "error" in result:
        print(f"  Failed to create '{name}': {result}")
        return False

    print(f"  Created collection '{name}'")
    return True


def seed_entities():
    """Seed entity vectors."""
    print("Seeding entities...")
    points = []
    for i, entity in enumerate(EXAMPLE_ENTITIES):
        text = f"{entity['name']}: {entity['description']}"
        points.append({
            "id": i + 1,
            "vector": generate_mock_embedding(text),
            "payload": {
                "entity_name": entity["name"],
                "description": entity["description"],
                "source_id": "example_seed",
            },
        })

    result = http_request(
        "PUT",
        f"{QDRANT_URL}/collections/lightrag_vdb_entities/points",
        {"points": points},
    )
    if "error" in result:
        print(f"  Failed: {result}")
    else:
        print(f"  Added {len(points)} entity vectors")


def seed_chunks():
    """Seed document chunk vectors."""
    print("Seeding chunks...")
    points = []
    for i, chunk in enumerate(EXAMPLE_CHUNKS):
        points.append({
            "id": i + 1,
            "vector": generate_mock_embedding(chunk["content"]),
            "payload": {
                "content": chunk["content"],
                "doc_id": chunk["doc_id"],
                "source_id": "example_seed",
            },
        })

    result = http_request(
        "PUT",
        f"{QDRANT_URL}/collections/lightrag_vdb_chunks/points",
        {"points": points},
    )
    if "error" in result:
        print(f"  Failed: {result}")
    else:
        print(f"  Added {len(points)} chunk vectors")


def seed_relationships():
    """Seed relationship vectors."""
    print("Seeding relationships...")
    points = []
    for i, rel in enumerate(EXAMPLE_RELATIONSHIPS):
        # Embed the relationship description for semantic search
        text = f"{rel['source']} {rel['relationship']} {rel['target']}: {rel['description']}"
        points.append({
            "id": i + 1,
            "vector": generate_mock_embedding(text),
            "payload": {
                "src_id": rel["source"],
                "tgt_id": rel["target"],
                "relationship": rel["relationship"],
                "description": rel["description"],
                "source_id": "example_seed",
            },
        })

    result = http_request(
        "PUT",
        f"{QDRANT_URL}/collections/lightrag_vdb_relationships/points",
        {"points": points},
    )
    if "error" in result:
        print(f"  Failed: {result}")
    else:
        print(f"  Added {len(points)} relationship vectors")


def main():
    """Main seeding function."""
    print("=" * 50)
    print("LightRAG Qdrant Seed Script")
    print("=" * 50)

    if not wait_for_qdrant():
        print("ERROR: Qdrant not available!")
        return 1

    print("\nCreating collections...")
    for name in COLLECTIONS:
        create_collection(name)

    print("\nSeeding data...")
    seed_entities()
    seed_relationships()
    seed_chunks()

    print("\n" + "=" * 50)
    print("Seeding complete!")
    print("=" * 50)
    return 0


if __name__ == "__main__":
    exit(main())
