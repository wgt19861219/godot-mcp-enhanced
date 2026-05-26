import { expect, describe, it } from "vitest";
import { chainOfVerification } from "../src/tools/game-design.js";

describe("Chain-of-Verification (CoV)", () => {
  it("should generate exactly 5 challenge questions", () => {
    const result = chainOfVerification("pass", "All systems validated successfully");

    expect(result.questions).toHaveLength(5);
  });

  it("should generate questions containing doubt patterns", () => {
    const result = chainOfVerification(
      "pass",
      "All systems validated successfully with comprehensive coverage",
    );

    const doubtPatterns = [
      /what if/i,
      /could/i,
      /might/i,
      /miss/i,
      /overlook/i,
      /assume/i,
      /wrong/i,
    ];

    // At least 3 of the 5 questions should contain a doubt pattern
    const matchingQuestions = result.questions.filter((q) =>
      doubtPatterns.some((p) => p.test(q)),
    );
    expect(matchingQuestions.length).toBeGreaterThanOrEqual(3);
  });

  it("should return original verdict and a confidence score", () => {
    const result = chainOfVerification("pass", "Full validation with no gaps detected");

    expect(result.original_verdict).toBe("pass");
    expect(result.confidence).toBeGreaterThanOrEqual(0.1);
    expect(result.confidence).toBeLessThanOrEqual(1.0);
    expect(result.recommendation).toBeTruthy();
  });

  it("should produce low confidence for weak context signals", () => {
    const result = chainOfVerification(
      "fail with concerns",
      "skipped",
    );

    // "skipped" in context → -0.15, "fail" in verdict → -0.15, "concerns" in verdict → -0.15
    // "skipped" context length < 30 → -0.15
    // Total: 0.9 - 0.15 - 0.15 - 0.15 - 0.15 = 0.3
    expect(result.confidence).toBeCloseTo(0.3);
    expect(result.confidence).toBeLessThan(0.7);
    expect(result.recommendation).toContain("Low confidence");
  });
});
