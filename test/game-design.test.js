import { expect, describe, it } from "vitest";
import {
  validateGDD,
  GDD_REQUIRED_SECTIONS,
  GDD_SECTION_HINTS,
  getToolDefinitions,
  handleTool,
  TOOL_META,
} from "../src/tools/game-design.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a GDD markdown string from a partial map of section → body. */
function buildGDD(sections) {
  return Object.entries(sections)
    .map(([name, body]) => `## ${name}\n\n${body}`)
    .join("\n\n");
}

/** All 8 sections with sufficient body content. */
function fullGDD(overrides = {}) {
  const defaults = {
    Overview:
      "This system handles player combat interactions including damage calculation, hit detection, and feedback.",
    "Player Fantasy":
      "The player feels like a skilled warrior who reads enemy patterns and strikes with precision.",
    "Detailed Rules":
      "1. Player can attack with light or heavy strikes. 2. Each strike consumes stamina. 3. Blocking reduces incoming damage by a percentage.",
    Formulas:
      "damage = base_damage * attack_multiplier - target_defense * defense_modifier",
    "Edge Cases":
      "When stamina reaches zero, attacks deal minimum damage. When target defense exceeds attack, damage is clamped to zero.",
    Dependencies:
      "- Combat system reads from Stats system\n- UI system displays health bars\n- Animation system triggers hit reactions",
    "Tuning Knobs":
      "- base_damage: default 10, range [1..100]\n- attack_multiplier: default 1.0, range [0.1..5.0]\n- defense_modifier: default 0.5, range [0..1]",
    "Acceptance Criteria":
      "- [ ] Player can deal damage to enemies\n- [ ] Damage formula produces expected results\n- [ ] Stamina system prevents infinite attacks\n- [ ] Blocking reduces damage correctly",
  };
  return buildGDD({ ...defaults, ...overrides });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GDD Validator", () => {
  it("should fail when required sections are missing", () => {
    const gdd = buildGDD({
      Overview: "A simple overview of the system.",
      "Player Fantasy": "The player feels powerful and strategic.",
    });

    const result = validateGDD(gdd);

    expect(result.passed).toBe(false);
    expect(result.sections_found).toHaveLength(2);
    expect(result.sections_missing).toHaveLength(6);
    const errors = result.issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(6);
    // Every error should be about a missing section
    for (const err of errors) {
      expect(err.message).toMatch(/Missing required section:/);
      expect(err.suggestion).toBeTruthy();
    }
  });

  it("should pass when all 8 sections are present", () => {
    const result = validateGDD(fullGDD());

    expect(result.passed).toBe(true);
    expect(result.sections_found).toHaveLength(8);
    expect(result.sections_missing).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });

  it("should warn when section body is too short (< 20 chars)", () => {
    const result = validateGDD(
      fullGDD({ Overview: "TODO" }),
    );

    expect(result.passed).toBe(true); // warnings don't fail
    const shortWarnings = result.issues.filter(
      (i) =>
        i.severity === "warning" &&
        i.location === "Overview" &&
        i.message.includes("too short"),
    );
    expect(shortWarnings).toHaveLength(1);
    expect(shortWarnings[0].suggestion).toContain("Overview");
  });

  it("should detect hardcoded numbers in formulas section", () => {
    const result = validateGDD(
      fullGDD({ Formulas: "damage = 10 + atk * 2.5" }),
    );

    const formulaWarnings = result.issues.filter(
      (i) =>
        i.severity === "warning" &&
        i.location === "Formulas" &&
        i.message.includes("Hardcoded"),
    );
    expect(formulaWarnings).toHaveLength(1);
    expect(formulaWarnings[0].message).toContain("10");
    expect(formulaWarnings[0].message).toContain("2.5");
  });

  it("should detect acceptance criteria without testable format", () => {
    const markdown = `# Test System
## Overview
A test system with enough content to pass.
## Player Fantasy
Feel powerful and engaged.
## Detailed Rules
Rules about the system behavior.
## Formulas
damage = atk * mult
## Edge Cases
When health reaches zero.
## Dependencies
Health system.
## Tuning Knobs
mult: 2.0
## Acceptance Criteria
The system should work correctly and players should enjoy using it.`;
    const result = validateGDD(markdown);
    const acWarnings = result.issues.filter(
      (i) => i.severity === "warning" && i.location === "Acceptance Criteria"
    );
    expect(acWarnings.length).toBeGreaterThanOrEqual(1);
    expect(acWarnings.some(w => w.message.includes("bullet list") || w.message.includes("testable"))).toBe(true);
  });
});

// ─── MCP Tool Registration Tests ──────────────────────────────────────────────

describe("Game Design MCP Tool Registration", () => {
  it("should register validate_gdd tool", () => {
    const tools = getToolDefinitions();
    const validateGddTool = tools.find((t) => t.name === "validate_gdd");

    expect(validateGddTool).toBeTruthy();
    expect(validateGddTool.inputSchema.required).toContain("project_path");
    expect(validateGddTool.inputSchema.required).toContain("gdd_path");
  });

  it("should register chain_verify tool", () => {
    const tools = getToolDefinitions();
    const chainVerifyTool = tools.find((t) => t.name === "chain_verify");

    expect(chainVerifyTool).toBeTruthy();
    expect(chainVerifyTool.inputSchema.required).toContain("verdict");
    expect(chainVerifyTool.inputSchema.required).toContain("context");
  });

  it("should have correct TOOL_META", () => {
    expect(TOOL_META.validate_gdd).toEqual({ readonly: true, long_running: false });
    expect(TOOL_META.chain_verify).toEqual({ readonly: true, long_running: false });
  });

  it("handleTool should return null for unknown tool", async () => {
    const result = await handleTool("unknown_tool_xyz", {}, {});
    expect(result).toBeNull();
  });
});
