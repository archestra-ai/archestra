import { expect, test } from "vitest";
import { isFireworksEndpoint } from "./fireworks-endpoint";

test.each([
  "https://api.fireworks.ai/inference",
  "https://api.fireworks.ai/inference/v1",
  "https://api.fireworks.ai:443/inference/v1/",
])("recognizes the documented inference endpoint %s", (url) => {
  expect(isFireworksEndpoint(url)).toBe(true);
});

test.each([
  undefined,
  "http://localhost:8000/v1",
  "https://api.fireworks.ai.example.test/inference/v1",
  "https://api.fireworks.ai@localhost/inference/v1",
  "https://user@api.fireworks.ai/inference/v1",
  "http://api.fireworks.ai/inference/v1",
  "https://api.fireworks.ai:8443/inference/v1",
  "https://api.fireworks.ai/custom/v1",
  "https://api.fireworks.ai/inference/v1?endpoint=other",
  "not a URL",
])("does not infer a paid endpoint from %s", (url) => {
  expect(isFireworksEndpoint(url)).toBe(false);
});
