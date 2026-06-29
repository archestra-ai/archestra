// Deterministic Patronus generator based on user_id
const PATRONUS_FORMS = [
  { form: "Stag", corporeal: true },
  { form: "Doe", corporeal: true },
  { form: "Otter", corporeal: true },
  { form: "Jack Russell Terrier", corporeal: true },
  { form: "Wolf", corporeal: true },
  { form: "Phoenix", corporeal: true },
  { form: "Fox", corporeal: true },
  { form: "Cat", corporeal: true },
  { form: "Wispy Vapour", corporeal: false },
  { form: "Thin Silver Shield", corporeal: false },
];

export function getPatronusForUser(userId: string): { form: string; corporeal: boolean } {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  const index = Math.abs(hash) % PATRONUS_FORMS.length;
  return PATRONUS_FORMS[index];
}

export function sortTool(
  tool_name: string,
  tool_description: string,
  please_not_slytherin?: boolean
): { house: "gryffindor" | "slytherin" | "ravenclaw" | "hufflepuff"; confidence: number; monologue: string } {
  const nameLower = tool_name.toLowerCase();
  const descLower = tool_description.toLowerCase();

  let house: "gryffindor" | "slytherin" | "ravenclaw" | "hufflepuff" = "hufflepuff";
  let confidence = 0.85;

  const slytherinKeywords = ["delete", "drop", "destroy", "remove", "truncate", "wipe", "force", "kill", "terminate", "unauthorized", "bypass", "exploit"];
  const gryffindorKeywords = ["create", "post", "publish", "deploy", "build", "run", "execute", "start", "stop", "restart", "push", "promote"];
  const ravenclawKeywords = ["analyze", "check", "lint", "calculate", "compute", "evaluate", "query", "search", "find", "validate", "parse"];

  if (slytherinKeywords.some(keyword => nameLower.includes(keyword) || descLower.includes(keyword))) {
    house = "slytherin";
  } else if (gryffindorKeywords.some(keyword => nameLower.includes(keyword) || descLower.includes(keyword))) {
    house = "gryffindor";
  } else if (ravenclawKeywords.some(keyword => nameLower.includes(keyword) || descLower.includes(keyword))) {
    house = "ravenclaw";
  } else {
    house = "hufflepuff";
  }

  // Respect "please_not_slytherin"
  if (house === "slytherin" && please_not_slytherin) {
    house = "gryffindor"; // Sorted to Gryffindor instead (bold request!)
    confidence = 0.95;
  }

  // Generate a thematic Sorting Hat monologue
  let monologue = "";
  if (house === "gryffindor") {
    monologue = `Ah, ${tool_name}! A bold endeavor, brave and true,
where daring deeds are what you do!
No fear of failure, no hesitation,
Gryffindor is your destination!`;
  } else if (house === "slytherin") {
    monologue = `Slytherin! For ${tool_name} seeks the path of power and pride,
where ambition and cunning cannot be denied.
But heed my warning, dark and deep:
unlocked secrets are yours to keep!`;
  } else if (house === "ravenclaw") {
    monologue = `Ravenclaw! For ${tool_name} shines with wisdom and light,
seeking logic and truth in the starry night.
To learn and analyze, to understand,
the cleverest house in all the land!`;
  } else {
    monologue = `Hufflepuff! For ${tool_name} works with steady grace,
a loyal helper in every place.
Patient and true, with heart so kind,
a better companion you will not find!`;
  }

  return { house, confidence, monologue };
}
