import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkflowState } from "./types.ts";
import { redactSecrets } from "./tools.ts";

export type WorkflowLogLevel = "debug" | "info" | "warn" | "error";

export function workflowLogPath(root: string, workflowId: string): string {
  return path.join(root, ".pi", "workflows", "runs", workflowId, "workflow.log");
}

function serialize(fields: Record<string, unknown>): string {
  if (Object.keys(fields).length === 0) return "";
  try {
    const json = JSON.stringify(fields).replace(
      /("(?:api[_-]?key|token|password|secret)"\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"',
    );
    return ` ${redactSecrets(json)}`;
  } catch {
    return " {\"fields\":\"[unserializable]\"}";
  }
}

/** Append a human-readable, structured record to the run's diagnostic log. */
export async function logWorkflow(
  state: Pick<WorkflowState, "repositoryRoot" | "workflowId">,
  level: WorkflowLogLevel,
  message: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const filePath = workflowLogPath(state.repositoryRoot, state.workflowId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redactSecrets(message)}${serialize(fields)}\n`;
  await fs.appendFile(filePath, line, "utf8");
}
