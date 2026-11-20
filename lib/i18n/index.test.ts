import { describe, expect, it } from "vitest";
import de from "@/messages/de.json";
import en from "@/messages/en.json";
import { t } from ".";

describe("messages", () => {
  it("have the same keys in every locale", () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
  });

  it("use the same placeholders in every locale", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(placeholders(de[key])).toEqual(placeholders(en[key]));
  });
});

describe("t", () => {
  it("fills placeholders and keeps unknown ones", () => {
    expect(t("en", "home.title", { brand: "Acme" })).toBe("Acme");
    expect(t("de", "home.title")).toBe("{brand}");
  });
});
