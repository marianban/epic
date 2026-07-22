import { createHash } from "node:crypto";
import type { PlanReviewInstruction } from "./types.ts";

export const REQUIRED_PLAN_SECTIONS = [
  "# Implementation Plan",
  "## Status",
  "## Objective",
  "## Scope",
  "## Repository Findings",
  "## Proposed Design",
  "## Implementation Steps",
  "## Acceptance Criteria",
  "## Verification",
  "## Risks and Edge Cases",
  "## Open Questions",
  "## Revision Log",
];

export function extractReviewInstructions(markdown: string): PlanReviewInstruction[] {
  return markdown.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^\s*R:\s*(.+?)\s*$/);
    return match ? [{ lineNumber: index + 1, text: match[1], rawLine: line }] : [];
  });
}

export interface PlanValidationResult { valid: boolean; errors: string[]; warnings: string[] }

export function validatePlanCompleteness(markdown: string): PlanValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const section of REQUIRED_PLAN_SECTIONS) {
    if (!markdown.includes(section)) errors.push(`Missing required section: ${section}`);
  }
  if (extractReviewInstructions(markdown).length > 0) errors.push("Plan contains unresolved R: review instructions.");
  if (!/^\s*(?:[-*]|\d+[.)])\s+.+/m.test(sectionBody(markdown, "## Implementation Steps"))) errors.push("Plan must contain at least one implementation step.");
  if (!/^\s*(?:[-*]|\[[ xX]\])\s+.+/m.test(sectionBody(markdown, "## Acceptance Criteria"))) errors.push("Plan must contain at least one acceptance criterion.");
  if (!/`[^`]+`|^\s*[-*]\s+\S/m.test(sectionBody(markdown, "## Verification"))) errors.push("Plan must contain at least one verification command.");
  if (!/### Create[\s\S]*?### Delete/.test(sectionBody(markdown, "## Scope"))) errors.push("Scope must explicitly contain Create and Delete subsections.");
  if (/\b(?:Approved|Complete)\b/i.test(sectionBody(markdown, "## Status"))) errors.push("Planner cannot mark a plan approved or complete.");
  if (/^\s*[-*]\s+(?:`)?(?:[/\\]|\.\.[/\\])/m.test(sectionBody(markdown, "## Scope"))) errors.push("Scope contains an absolute or parent-traversal path.");
  if (/(^|\s)(?:TODO|TBD)(?=\s|$)/i.test(markdown) && !/## Open Questions[\s\S]*?(?:TODO|TBD)/i.test(markdown)) errors.push("TODO/TBD is only allowed under Open Questions.");
  if (/refactor as needed|do whatever is necessary|etc\.?/i.test(markdown)) warnings.push("Plan contains broad language; confirm its scope before approval.");
  return { valid: errors.length === 0, errors, warnings };
}

export function validatePlanRevision(previousPlan: string, revisedPlan: string, instructions: PlanReviewInstruction[]): void {
  if (extractReviewInstructions(revisedPlan).length > 0) throw new Error("Planner revision left unresolved R: comments in plan.md.");
  const validation = validatePlanCompleteness(revisedPlan);
  if (!validation.valid) throw new Error(`Invalid revised plan: ${validation.errors.join(" ")}`);
  for (const instruction of instructions) {
    const terms = instruction.text.toLowerCase().split(/\s+/).filter((term) => term.length > 4).slice(0, 3);
    if (terms.length > 0 && !terms.some((term) => revisedPlan.toLowerCase().includes(term))) {
      throw new Error(`Revision does not appear to address review instruction: ${instruction.text}`);
    }
  }
  if (revisedPlan.trim() === previousPlan.trim()) throw new Error("Planner returned an unchanged plan for a requested revision.");
}

export function hashPlan(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function sectionBody(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const body = markdown.slice(start + heading.length);
  const nextHeading = body.search(/^##\s/m);
  return nextHeading < 0 ? body : body.slice(0, nextHeading);
}
