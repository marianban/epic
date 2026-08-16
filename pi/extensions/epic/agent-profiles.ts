import type {
  AgentProfile,
  AgentRole,
  ResolvedEpicConfiguration,
} from './types.ts'

const DEFAULT_AGENT_PROFILES: Record<AgentRole, AgentProfile> = {
  scout: {
    role: 'scout',
    systemPromptPath: '.pi/agents/scout.md',
    tools: ['read', 'grep', 'find', 'ls', 'bash'],
    readOnly: true,
    temperature: 0.1,
    thinking: 'low',
  },
  planner: {
    role: 'planner',
    systemPromptPath: '.pi/agents/planner.md',
    tools: ['read', 'grep', 'find', 'ls'],
    readOnly: true,
    temperature: 0.1,
    thinking: 'high',
  },
  'plan-reviewer': {
    role: 'plan-reviewer',
    systemPromptPath: '.pi/agents/plan-reviewer.md',
    tools: ['read', 'grep', 'find', 'ls'],
    readOnly: true,
    temperature: 0.1,
    thinking: 'low',
  },
  'task-reviewer': {
    role: 'task-reviewer',
    systemPromptPath: '.pi/agents/task-reviewer.md',
    tools: ['read', 'grep', 'find', 'ls'],
    readOnly: true,
    temperature: 0.1,
    thinking: 'low',
  },
  implementer: {
    role: 'implementer',
    systemPromptPath: '.pi/agents/implementer.md',
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
    readOnly: false,
    temperature: 0.1,
    thinking: 'high',
  },
  reviewer: {
    role: 'reviewer',
    systemPromptPath: '.pi/agents/reviewer.md',
    tools: ['read', 'grep', 'find', 'ls', 'bash'],
    readOnly: true,
    temperature: 0.1,
    thinking: 'high',
  },
}

export const CANONICAL_AGENT_ROLE_ORDER: readonly AgentRole[] = [
  'scout',
  'planner',
  'implementer',
  'reviewer',
  'plan-reviewer',
  'task-reviewer',
]

function mergeAgentProfile(
  role: AgentRole,
  configuration: ResolvedEpicConfiguration
): AgentProfile {
  const override = configuration.agents[role] ?? {}
  const base = DEFAULT_AGENT_PROFILES[role]
  return {
    ...base,
    ...override,
    role,
    systemPromptPath: override.systemPromptPath ?? base.systemPromptPath,
    tools: override.tools ?? base.tools,
    readOnly: override.readOnly ?? base.readOnly,
  }
}

export function resolveAgentProfile(
  role: AgentRole,
  configuration: ResolvedEpicConfiguration
): AgentProfile {
  return mergeAgentProfile(role, configuration)
}

export function resolveAgentProfiles(
  configuration: ResolvedEpicConfiguration
): readonly AgentProfile[] {
  return CANONICAL_AGENT_ROLE_ORDER.map((role) =>
    resolveAgentProfile(role, configuration)
  )
}

export function compareAgentRoles(left: string, right: string): number {
  const leftIndex = CANONICAL_AGENT_ROLE_ORDER.indexOf(left as AgentRole)
  const rightIndex = CANONICAL_AGENT_ROLE_ORDER.indexOf(right as AgentRole)
  const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex
  const normalizedRight =
    rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex
  if (normalizedLeft !== normalizedRight) return normalizedLeft - normalizedRight
  return left.localeCompare(right)
}
