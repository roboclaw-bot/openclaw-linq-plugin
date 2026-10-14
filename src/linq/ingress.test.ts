import { expect, it } from "vitest";
import { normalizeLinqSender } from "./ingress.js";
it("normalizes telephone formatting without merging significant email punctuation", () => {
  expect(normalizeLinqSender("+1 (555) 555-0102")).toBe("+15555550102");
  expect(normalizeLinqSender("first.last@outlook.com")).not.toBe(
    normalizeLinqSender("firstlast@outlook.com"),
  );
});
