// LightRAG Example Knowledge Graph Seed Data
// This creates sample entities and relationships for demo/testing purposes

// Create Company entities
CREATE (acme:ORGANIZATION {
  name: "Acme Corporation",
  description: "Technology company specializing in artificial intelligence solutions for enterprise customers. Founded in 2015 in San Francisco.",
  entity_type: "ORGANIZATION",
  source_id: "example_seed"
})

CREATE (google:ORGANIZATION {
  name: "Google",
  description: "Multinational technology corporation",
  entity_type: "ORGANIZATION",
  source_id: "example_seed"
})

CREATE (sequoia:ORGANIZATION {
  name: "Sequoia Capital",
  description: "Venture capital firm that led Acme's Series B funding",
  entity_type: "ORGANIZATION",
  source_id: "example_seed"
})

CREATE (mit:ORGANIZATION {
  name: "MIT CSAIL",
  description: "MIT Computer Science and Artificial Intelligence Laboratory",
  entity_type: "ORGANIZATION",
  source_id: "example_seed"
})

CREATE (stanford:ORGANIZATION {
  name: "Stanford AI Lab",
  description: "Stanford University Artificial Intelligence Laboratory",
  entity_type: "ORGANIZATION",
  source_id: "example_seed"
})

CREATE (nsf:ORGANIZATION {
  name: "National Science Foundation",
  description: "US government agency supporting research and education",
  entity_type: "ORGANIZATION",
  source_id: "example_seed"
})

// Create Person entities
CREATE (sarah:PERSON {
  name: "Sarah Chen",
  description: "CEO of Acme Corporation. Previously Senior Engineer at Google.",
  entity_type: "PERSON",
  source_id: "example_seed"
})

CREATE (michael:PERSON {
  name: "Michael Rodriguez",
  description: "CTO of Acme Corporation and co-founder. Leads engineering team of 50 engineers.",
  entity_type: "PERSON",
  source_id: "example_seed"
})

CREATE (emily:PERSON {
  name: "Dr. Emily Watson",
  description: "Research scientist leading Project Aurora. Joined from MIT CSAIL.",
  entity_type: "PERSON",
  source_id: "example_seed"
})

// Create Product entities
CREATE (acmeai:PRODUCT {
  name: "AcmeAI",
  description: "Enterprise-grade machine learning platform for building, deploying, and monitoring ML models at scale.",
  entity_type: "PRODUCT",
  source_id: "example_seed"
})

// Create Project entities
CREATE (aurora:PROJECT {
  name: "Project Aurora",
  description: "Research initiative focused on next-generation NLP capabilities using knowledge graphs and RAG.",
  entity_type: "PROJECT",
  source_id: "example_seed"
})

// Create Location entities
CREATE (sf:LOCATION {
  name: "San Francisco",
  description: "City in California, headquarters of Acme Corporation",
  entity_type: "LOCATION",
  source_id: "example_seed"
})

CREATE (nyc:LOCATION {
  name: "New York City",
  description: "City in New York, location of Acme office",
  entity_type: "LOCATION",
  source_id: "example_seed"
})

CREATE (london:LOCATION {
  name: "London",
  description: "Capital of UK, location of Acme office",
  entity_type: "LOCATION",
  source_id: "example_seed"
})

// Create Technology entities
CREATE (aws:TECHNOLOGY {
  name: "AWS",
  description: "Amazon Web Services cloud platform",
  entity_type: "TECHNOLOGY",
  source_id: "example_seed"
})

CREATE (gcp:TECHNOLOGY {
  name: "Google Cloud",
  description: "Google Cloud Platform",
  entity_type: "TECHNOLOGY",
  source_id: "example_seed"
})

CREATE (azure:TECHNOLOGY {
  name: "Microsoft Azure",
  description: "Microsoft's cloud computing platform",
  entity_type: "TECHNOLOGY",
  source_id: "example_seed"
})

// Create relationships
CREATE (sarah)-[:FOUNDED {weight: 1.0, source_id: "example_seed"}]->(acme)
CREATE (michael)-[:FOUNDED {weight: 1.0, source_id: "example_seed"}]->(acme)
CREATE (sarah)-[:CEO_OF {weight: 1.0, source_id: "example_seed"}]->(acme)
CREATE (michael)-[:CTO_OF {weight: 1.0, source_id: "example_seed"}]->(acme)
CREATE (sarah)-[:PREVIOUSLY_WORKED_AT {weight: 0.8, source_id: "example_seed"}]->(google)
CREATE (emily)-[:LEADS {weight: 1.0, source_id: "example_seed"}]->(aurora)
CREATE (emily)-[:REPORTS_TO {weight: 0.9, source_id: "example_seed"}]->(michael)
CREATE (emily)-[:PREVIOUSLY_AT {weight: 0.8, source_id: "example_seed"}]->(mit)

CREATE (acme)-[:PRODUCES {weight: 1.0, source_id: "example_seed"}]->(acmeai)
CREATE (acme)-[:RUNS {weight: 1.0, source_id: "example_seed"}]->(aurora)
CREATE (acme)-[:HEADQUARTERED_IN {weight: 1.0, source_id: "example_seed"}]->(sf)
CREATE (acme)-[:HAS_OFFICE_IN {weight: 0.8, source_id: "example_seed"}]->(nyc)
CREATE (acme)-[:HAS_OFFICE_IN {weight: 0.8, source_id: "example_seed"}]->(london)
CREATE (acme)-[:FUNDED_BY {weight: 0.9, source_id: "example_seed"}]->(sequoia)

CREATE (acmeai)-[:INTEGRATES_WITH {weight: 0.9, source_id: "example_seed"}]->(aws)
CREATE (acmeai)-[:INTEGRATES_WITH {weight: 0.9, source_id: "example_seed"}]->(gcp)
CREATE (acmeai)-[:INTEGRATES_WITH {weight: 0.9, source_id: "example_seed"}]->(azure)

CREATE (aurora)-[:COLLABORATES_WITH {weight: 0.8, source_id: "example_seed"}]->(stanford)
CREATE (aurora)-[:FUNDED_BY {weight: 0.9, source_id: "example_seed"}]->(nsf)

// Return summary
RETURN "Seeded " + toString(count(*)) + " nodes and relationships" AS result;
