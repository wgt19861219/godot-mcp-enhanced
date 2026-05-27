// ─── GDD Validator Types ─────────────────────────────────────────────────────

export interface GDDIssue {
  severity: "error" | "warning";
  location: string;
  message: string;
  suggestion?: string;
}

export interface GDDValidationResult {
  passed: boolean;
  sections_found: string[];
  sections_missing: string[];
  issues: GDDIssue[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const GDD_REQUIRED_SECTIONS = [
  "Overview",
  "Player Fantasy",
  "Detailed Rules",
  "Formulas",
  "Edge Cases",
  "Dependencies",
  "Tuning Knobs",
  "Acceptance Criteria",
] as const;

export const GDD_SECTION_HINTS: Record<string, string> = {
  Overview:
    "Describe the system's purpose, scope, and how it fits into the larger game.",
  "Player Fantasy":
    "What experience does this system deliver to the player? How should it feel?",
  "Detailed Rules":
    "Enumerate every rule the system follows. Be explicit and unambiguous.",
  Formulas:
    "Define all math using named variables (e.g., damage = base_damage * multiplier), not raw numbers.",
  "Edge Cases":
    "List boundary conditions: min/max values, ties, empty states, overflow, etc.",
  Dependencies:
    "List other systems this one reads from or writes to. Use bullet format. Write 'None' if standalone.",
  "Tuning Knobs":
    "Identify every configurable parameter with its current default, range, and effect.",
  "Acceptance Criteria":
    "Write testable bullet items (- or *) that a QA engineer can verify. Each must be pass/fail.",
};

// ─── Validator ───────────────────────────────────────────────────────────────

const MIN_SECTION_BODY_LENGTH = 20;

/**
 * Extracts the body text of a section starting after `## Section Name`
 * up to the next `## ` header or end of document.
 */
function extractSectionBody(markdown: string, sectionName: string): string {
  const headerRegex = new RegExp(
    `^##\\s+${escapeRegex(sectionName)}\\s*$`,
    "m",
  );
  const match = headerRegex.exec(markdown);
  if (!match) return "";

  const start = match.index + match[0].length;
  const rest = markdown.slice(start);

  // Find the next ## header (not ### or deeper)
  const nextHeader = rest.search(/^## /m);
  const body = nextHeader === -1 ? rest : rest.slice(0, nextHeader);

  return body.trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Checks if the Formulas section body contains hardcoded numbers
 * that are not part of variable names.
 * Matches standalone numbers like `10`, `2.5` but not `var_name_1` or `Vector3`.
 */
function findHardcodedNumbers(body: string): number[] {
  // Match numbers not preceded by a word character (letter or underscore or digit)
  // This catches: "10", "+ 2.5", "= 3", " * 0.5"
  // But not: "atk_1", "_2nd", "base_10_value"
  const regex = /(?<![a-zA-Z_])\b\d+(?:\.\d+)?\b/g;
  const results: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    results.push(parseFloat(m[0]));
  }
  return results;
}

/**
 * Checks if a string contains bullet list items (- or * at line start).
 */
function hasBulletItems(text: string): boolean {
  return /^\s*[-*]\s+/m.test(text);
}

export function validateGDD(markdown: string): GDDValidationResult {
  const issues: GDDIssue[] = [];
  const sections_found: string[] = [];
  const sections_missing: string[] = [];

  // 1. Check all required sections exist
  for (const section of GDD_REQUIRED_SECTIONS) {
    const headerRegex = new RegExp(
      `^##\\s+${escapeRegex(section)}\\s*$`,
      "m",
    );
    if (headerRegex.test(markdown)) {
      sections_found.push(section);
    } else {
      sections_missing.push(section);
      issues.push({
        severity: "error",
        location: section,
        message: `Missing required section: ${section}`,
        suggestion: GDD_SECTION_HINTS[section],
      });
    }
  }

  // 2. Check section body length for found sections
  for (const section of sections_found) {
    const body = extractSectionBody(markdown, section);
    if (body.length < MIN_SECTION_BODY_LENGTH) {
      issues.push({
        severity: "warning",
        location: section,
        message: `Section body is too short (${body.length} chars, minimum ${MIN_SECTION_BODY_LENGTH})`,
        suggestion: `Expand the ${section} section. ${GDD_SECTION_HINTS[section]}`,
      });
    }
  }

  // 3. Formulas: warn about hardcoded numbers
  if (sections_found.includes("Formulas")) {
    const body = extractSectionBody(markdown, "Formulas");
    if (body.length > 0) {
      const numbers = findHardcodedNumbers(body);
      if (numbers.length > 0) {
        issues.push({
          severity: "warning",
          location: "Formulas",
          message: `Hardcoded numbers found: ${numbers.join(", ")}`,
          suggestion:
            "Replace raw numbers with named tuning variables (e.g., base_damage, multiplier).",
        });
      }
    }
  }

  // 4. Acceptance Criteria: warn if no bullet list items
  if (sections_found.includes("Acceptance Criteria")) {
    const body = extractSectionBody(markdown, "Acceptance Criteria");
    if (body.length > 0 && !hasBulletItems(body)) {
      issues.push({
        severity: "warning",
        location: "Acceptance Criteria",
        message:
          "Acceptance Criteria should use bullet list items (- or *) for testable checks",
        suggestion:
          "Rewrite as a bullet list, e.g.:\n- [ ] When player deals damage, health decreases by the expected amount",
      });
    }
  }

  // 5. Dependencies: warn if content exists but not in bullet format and not "None"
  if (sections_found.includes("Dependencies")) {
    const body = extractSectionBody(markdown, "Dependencies");
    if (
      body.length > 0 &&
      body.toLowerCase() !== "none" &&
      !hasBulletItems(body)
    ) {
      issues.push({
        severity: "warning",
        location: "Dependencies",
        message:
          "Dependencies section should use bullet list format or state 'None'",
        suggestion:
          "List dependencies as bullet items, e.g.:\n- Combat system (reads player stats)\n- UI system (displays health bar)",
      });
    }
  }

  const passed =
    sections_missing.length === 0 &&
    !issues.some((i) => i.severity === "error");

  return { passed, sections_found, sections_missing, issues };
}

// ─── Chain-of-Verification Self-Challenge Engine ──────────────────────────────

export interface CoVResult {
  original_verdict: string;
  questions: string[];
  confidence: number;
  recommendation: string;
}

const COV_QUESTION_TEMPLATES = [
  "What if the analysis {reason} — could the verdict '{verdict}' be based on incomplete context from '{context}'?",
  "Could there be hidden assumptions in the verdict '{verdict}' that might not hold given the context '{context}'?",
  "Might this verdict overlook edge cases or boundary conditions that '{context}' does not explicitly address?",
  "Is it possible that '{context}' contains misleading signals that led to the verdict '{verdict}'?",
  "What if the evidence in '{context}' is wrong or outdated — would the verdict '{verdict}' still be valid?",
] as const;

const WEAK_SIGNALS_CONTEXT = ["skipped", "only checked", "partial"] as const;
const WEAK_SIGNALS_VERDICT = ["concerns", "fail"] as const;

export function chainOfVerification(verdict: string, context: string): CoVResult {
  // 1. Generate exactly 5 challenge questions
  const reason = "missed critical interactions between subsystems";
  const questions = COV_QUESTION_TEMPLATES.map((tpl) =>
    tpl
      .replace(/\{verdict\}/g, verdict)
      .replace(/\{context\}/g, context)
      .replace(/\{reason\}/g, reason),
  );

  // 2. Calculate confidence
  let confidence = 0.9;

  const contextLower = context.toLowerCase();
  const verdictLower = verdict.toLowerCase();

  for (const signal of WEAK_SIGNALS_CONTEXT) {
    if (contextLower.includes(signal)) confidence -= 0.15;
  }
  for (const signal of WEAK_SIGNALS_VERDICT) {
    if (verdictLower.includes(signal)) confidence -= 0.15;
  }
  if (context.length < 30) confidence -= 0.15;

  // 3. Clamp to [0.1, 1.0]
  confidence = Math.max(0.1, Math.min(1.0, confidence));

  // 4. Recommendation
  let recommendation: string;
  if (confidence < 0.7) {
    recommendation = "Low confidence — recommend manual review before proceeding";
  } else if (confidence < 0.9) {
    recommendation = "Moderate confidence — verify key concerns manually";
  } else {
    recommendation = "High confidence — verdict is well-supported by evidence";
  }

  return {
    original_verdict: verdict,
    questions,
    confidence,
    recommendation,
  };
}

// ─── MCP Tool Registration ────────────────────────────────────────────────────

import { readFileSync } from "fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext, ToolResult } from "../types.js";
import { validatePath, resolveWithinRoot } from "../helpers.js";

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: "validate_gdd",
      description:
        "Validate a Game Design Document (GDD) markdown file against required sections and quality rules.",
      inputSchema: {
        type: "object" as const,
        properties: {
          project_path: {
            type: "string",
            description: "Path to the Godot project directory",
          },
          gdd_path: {
            type: "string",
            description:
              "Path to the GDD markdown file, relative to project root",
          },
        },
        required: ["project_path", "gdd_path"],
      },
    },
    {
      name: "chain_verify",
      description:
        "Run Chain-of-Verification self-challenge on a verdict to assess confidence and generate challenge questions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          verdict: {
            type: "string",
            description: "The verdict or conclusion to challenge",
          },
          context: {
            type: "string",
            description: "The supporting context or evidence for the verdict",
          },
        },
        required: ["verdict", "context"],
      },
    },
  ];
}

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case "validate_gdd": {
      const projectPath = validatePath(args.project_path as string);
      const fullPath = resolveWithinRoot(projectPath, args.gdd_path as string);
      let content: string;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ passed: false, error: `Failed to read GDD file: ${(err as Error).message}` }) },
          ],
        };
      }
      const result = validateGDD(content);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
    case "chain_verify": {
      const verdict = args.verdict as string;
      const context = args.context as string;
      const result = chainOfVerification(verdict, context);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    }
    default:
      return null;
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  validate_gdd: { readonly: true, long_running: false },
  chain_verify: { readonly: true, long_running: false },
};
