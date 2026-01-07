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

// Create Cartoon Animal entities
CREATE (zippy:CARTOON_CHARACTER {
  name: "Zippy the Squirrel",
  description: "Hyperactive red squirrel who hoards gadgets instead of acorns. Loves coffee and inventing contraptions that usually explode.",
  entity_type: "CARTOON_CHARACTER",
  species: "Squirrel",
  source_id: "example_seed"
})

CREATE (grumbles:CARTOON_CHARACTER {
  name: "Grumbles the Badger",
  description: "Perpetually grumpy old badger who secretly has a heart of gold. Runs a repair shop in the forest.",
  entity_type: "CARTOON_CHARACTER",
  species: "Badger",
  source_id: "example_seed"
})

CREATE (mango:CARTOON_CHARACTER {
  name: "Mango the Parrot",
  description: "Flamboyant tropical parrot who speaks in riddles and runs a detective agency from a treehouse.",
  entity_type: "CARTOON_CHARACTER",
  species: "Parrot",
  source_id: "example_seed"
})

CREATE (chester:CARTOON_CHARACTER {
  name: "Chester McWhiskers",
  description: "Sophisticated orange tabby cat with a monocle who fancies himself a gentleman thief but keeps getting caught.",
  entity_type: "CARTOON_CHARACTER",
  species: "Cat",
  source_id: "example_seed"
})

CREATE (nibbles:CARTOON_CHARACTER {
  name: "Nibbles",
  description: "Tiny but fierce hamster who dreams of being a knight. Rides around on a remote-controlled car.",
  entity_type: "CARTOON_CHARACTER",
  species: "Hamster",
  source_id: "example_seed"
})

CREATE (thunderhoof:CARTOON_CHARACTER {
  name: "Thunderhoof",
  description: "Dramatic llama who believes he's a superhero. His power is spitting with incredible accuracy.",
  entity_type: "CARTOON_CHARACTER",
  species: "Llama",
  source_id: "example_seed"
})

CREATE (professor:CARTOON_CHARACTER {
  name: "Professor Shellsworth",
  description: "Elderly tortoise scientist who invents time machines but always forgets where he left them.",
  entity_type: "CARTOON_CHARACTER",
  species: "Tortoise",
  source_id: "example_seed"
})

CREATE (bandit:CARTOON_CHARACTER {
  name: "Bandit",
  description: "Mischievous raccoon who runs a black market for shiny objects. Actually quite philosophical.",
  entity_type: "CARTOON_CHARACTER",
  species: "Raccoon",
  source_id: "example_seed"
})

CREATE (bubbles:CARTOON_CHARACTER {
  name: "Bubbles the Axolotl",
  description: "Eternally cheerful pink axolotl who runs an underwater bakery. Her cupcakes cause temporary floating.",
  entity_type: "CARTOON_CHARACTER",
  species: "Axolotl",
  source_id: "example_seed"
})

CREATE (captain:CARTOON_CHARACTER {
  name: "Captain Whiskerface",
  description: "Retired pirate otter who now runs a boat rental service. Tells wildly exaggerated tales of his adventures.",
  entity_type: "CARTOON_CHARACTER",
  species: "Otter",
  source_id: "example_seed"
})

CREATE (boris:CARTOON_CHARACTER {
  name: "Boris the Moose",
  description: "Gentle giant moose who works as a librarian. Accidentally destroys things due to his size but everyone forgives him.",
  entity_type: "CARTOON_CHARACTER",
  species: "Moose",
  source_id: "example_seed"
})

// Create Cartoon Show entities
CREATE (forestchaos:SHOW {
  name: "Forest Chaos",
  description: "Animated comedy series about woodland creatures causing mayhem in Pinecone Valley",
  entity_type: "SHOW",
  source_id: "example_seed"
})

CREATE (detectivemango:SHOW {
  name: "Detective Mango Mysteries",
  description: "Animated mystery series following a parrot detective solving crimes in the jungle",
  entity_type: "SHOW",
  source_id: "example_seed"
})

CREATE (underwatercafe:SHOW {
  name: "The Underwater Cafe",
  description: "Slice-of-life animated series set in a cozy cafe at the bottom of a lake",
  entity_type: "SHOW",
  source_id: "example_seed"
})

CREATE (heroesofnowhere:SHOW {
  name: "Heroes of Nowhere",
  description: "Action-comedy about misfit animals who accidentally become superheroes",
  entity_type: "SHOW",
  source_id: "example_seed"
})

// Create cartoon relationships
CREATE (zippy)-[:BEST_FRIENDS_WITH {weight: 1.0, source_id: "example_seed"}]->(grumbles)
CREATE (zippy)-[:ANNOYS {weight: 0.9, source_id: "example_seed"}]->(grumbles)
CREATE (chester)-[:RIVALS_WITH {weight: 0.9, source_id: "example_seed"}]->(mango)
CREATE (mango)-[:INVESTIGATES {weight: 1.0, source_id: "example_seed"}]->(chester)
CREATE (nibbles)-[:SIDEKICK_OF {weight: 1.0, source_id: "example_seed"}]->(thunderhoof)
CREATE (professor)-[:MENTORS {weight: 0.9, source_id: "example_seed"}]->(zippy)
CREATE (bandit)-[:TRADES_WITH {weight: 0.8, source_id: "example_seed"}]->(chester)
CREATE (bubbles)-[:BEST_FRIENDS_WITH {weight: 1.0, source_id: "example_seed"}]->(captain)
CREATE (boris)-[:PROTECTS {weight: 0.9, source_id: "example_seed"}]->(nibbles)
CREATE (professor)-[:CUSTOMER_OF {weight: 0.9, source_id: "example_seed"}]->(acme)

CREATE (zippy)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(forestchaos)
CREATE (grumbles)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(forestchaos)
CREATE (nibbles)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(forestchaos)
CREATE (boris)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(forestchaos)
CREATE (mango)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(detectivemango)
CREATE (chester)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(detectivemango)
CREATE (bubbles)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(underwatercafe)
CREATE (captain)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(underwatercafe)
CREATE (thunderhoof)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(heroesofnowhere)
CREATE (bandit)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(heroesofnowhere)
CREATE (professor)-[:STARS_IN {weight: 1.0, source_id: "example_seed"}]->(heroesofnowhere)

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
