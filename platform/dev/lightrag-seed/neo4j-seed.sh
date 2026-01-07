#!/bin/bash
# Wait for Neo4j and seed example data

NEO4J_URI="${NEO4J_URI:-bolt://neo4j:7687}"
NEO4J_USER="${NEO4J_USER:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-password123}"

echo "=================================================="
echo "LightRAG Neo4j Seed Script"
echo "=================================================="

# Wait for Neo4j to be ready
echo "Waiting for Neo4j to be ready..."
for i in {1..60}; do
    if cypher-shell -a "$NEO4J_URI" -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" "RETURN 1" > /dev/null 2>&1; then
        echo "Neo4j is ready!"
        break
    fi
    echo "  Retry $i/60..."
    sleep 2
done

# Check if already seeded
SEED_CHECK=$(cypher-shell -a "$NEO4J_URI" -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" \
    "MATCH (n {source_id: 'example_seed'}) RETURN count(n) as count" 2>/dev/null | tail -1)

if [[ "$SEED_CHECK" =~ [1-9] ]]; then
    echo "Database already seeded, skipping."
    exit 0
fi

echo ""
echo "Seeding Neo4j with example knowledge graph data..."

# Run the Cypher seed script
cypher-shell -a "$NEO4J_URI" -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" < /seed/neo4j-seed.cypher

if [ $? -eq 0 ]; then
    echo ""
    echo "=================================================="
    echo "Neo4j seeding complete!"
    echo "=================================================="
else
    echo "ERROR: Seeding failed!"
    exit 1
fi
