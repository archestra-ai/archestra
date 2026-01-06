#!/usr/bin/env python3
"""Seed Qdrant with example vector data for LightRAG demo."""

import json
import random
import time
import urllib.request
import urllib.error

QDRANT_URL = "http://qdrant:6333"
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
    req = urllib.request.Request(
        url,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    if data:
        req.data = json.dumps(data).encode("utf-8")

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
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
    seed_chunks()

    print("\n" + "=" * 50)
    print("Seeding complete!")
    print("=" * 50)
    return 0


if __name__ == "__main__":
    exit(main())
