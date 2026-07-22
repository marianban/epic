import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  cancelWorkflow,
  approvePlan,
  resumeWorkflow,
  reviewPlan,
  startWorkflow,
  workflowStatus,
} from './workflow.ts';

export default function workflowExtension(pi: ExtensionAPI): void {
  pi.registerCommand('workflow', {
    description: 'Start a deterministic human-gated workflow',
    handler: async (args, ctx) => startWorkflow(args, ctx),
  });
  pi.registerCommand('workflow-status', {
    description: 'Show active workflow state',
    handler: async (_args, ctx) => workflowStatus(ctx),
  });
  pi.registerCommand('workflow-resume', {
    description: 'Resume the persisted workflow',
    handler: async (_args, ctx) => resumeWorkflow(ctx),
  });
  pi.registerCommand('workflow-cancel', {
    description: 'Cancel without reverting repository changes',
    handler: async (_args, ctx) => cancelWorkflow(ctx),
  });
  pi.registerCommand('plan-review', {
    description: 'Revise plan.md from R: comments',
    handler: async (_args, ctx) => reviewPlan(ctx),
  });
  pi.registerCommand('plan-approve', {
    description: 'Approve plan.md and complete the planning phase',
    handler: async (_args, ctx) => approvePlan(ctx),
  });
  pi.registerCommand('plan-revise', {
    description: 'Force another Planner revision',
    handler: async (_args, ctx) => reviewPlan(ctx, true),
  });
}
