import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { optionalEnvKeys, requiredEnvKeys } from "@/lib/config";

it(".env.example lists exactly the variables lib/config.ts reads", () => {
  const keys = readFileSync(new URL("../../.env.example", import.meta.url), "utf8")
    .split("\n")
    .map((line) => line.match(/^([A-Z0-9_]+)=/)?.[1])
    .filter(Boolean);
  expect(keys.sort()).toEqual([...requiredEnvKeys, ...optionalEnvKeys].sort());
});
