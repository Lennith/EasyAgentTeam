import type {
  ProjectSummary,
  ProjectDetail,
  SessionRecord,
  TaskTreeNode,
  TaskTreeResponse,
  LockRecord,
  EventRecord,
  AgentIOTimelineItem,
  OrchestratorStatus,
  AgentDefinition,
  AgentTemplateDefinition,
  TemplateDefinition,
  SkillDefinition,
  SkillListDefinition
} from "@/types";

const now = new Date().toISOString();
const hourAgo = new Date(Date.now() - 3600000).toISOString();
const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();

export const mockProjects: ProjectSummary[] = [
  { projectId: "demo_project", name: "Demo Project", workspacePath: "/workspace/demo" },
  { projectId: "web_app", name: "Web Application", workspacePath: "/workspace/web-app" },
  { projectId: "api_service", name: "API Service", workspacePath: "/workspace/api" }
];

export const mockProjectDetail: ProjectDetail = {
  projectId: "demo_project",
  name: "Demo Project",
  workspacePath: "/workspace/demo",
  createdAt: twoHoursAgo,
  updatedAt: now,
  templateId: "default",
  agentIds: ["pm", "backend_dev", "frontend_dev", "qa"],
  routeTable: {
    pm: ["backend_dev", "frontend_dev", "qa"],
    backend_dev: ["pm", "qa"],
    frontend_dev: ["pm", "qa"],
    qa: ["pm"]
  },
  taskAssignRouteTable: {
    pm: ["backend_dev", "frontend_dev", "qa"],
    backend_dev: ["qa"],
    frontend_dev: ["qa"]
  },
  routeDiscussRounds: { pm: { backend_dev: 2 } },
  agentModelConfigs: {
    backend_dev: { provider_id: "codex", model: "gpt-4", effort: "high" },
    frontend_dev: { provider_id: "trae", model: "claude-3", effort: "medium" }
  },
  autoDispatchEnabled: true,
  autoDispatchRemaining: 5,
  roleSessionMap: { pm: "session-pm-001" }
};

export const mockSessions: SessionRecord[] = [
  {
    sessionId: "session-pm-001",
    projectId: "demo_project",
    role: "pm",
    status: "running",
    createdAt: twoHoursAgo,
    updatedAt: now,
    currentTaskId: "task_001",
    lastHeartbeat: now
  },
  {
    sessionId: "session-backend-001",
    projectId: "demo_project",
    role: "backend_dev",
    status: "running",
    createdAt: hourAgo,
    updatedAt: now,
    currentTaskId: "task_002",
    lastHeartbeat: now
  },
  {
    sessionId: "session-frontend-001",
    projectId: "demo_project",
    role: "frontend_dev",
    status: "idle",
    createdAt: hourAgo,
    updatedAt: hourAgo,
    lastHeartbeat: hourAgo
  },
  {
    sessionId: "session-qa-001",
    projectId: "demo_project",
    role: "qa",
    status: "blocked",
    createdAt: twoHoursAgo,
    updatedAt: hourAgo,
    lastHeartbeat: hourAgo
  }
];

export const mockTaskTree: TaskTreeResponse = {
  project_id: "demo_project",
  generated_at: now,
  query: {},
  roots: ["task_root_001"],
  focus: null,
  nodes: [
    {
      task_id: "task_root_001",
      task_kind: "PROJECT_ROOT",
      parent_task_id: null,
      root_task_id: null,
      title: "Demo Project Root",
      state: "IN_PROGRESS",
      creator_role: null,
      creator_session_id: null,
      owner_role: "pm",
      owner_session: "session-pm-001",
      priority: 1,
      dependencies: [],
      write_set: [],
      acceptance: [],
      artifacts: [],
      alert: null,
      granted_at: twoHoursAgo,
      closed_at: null,
      last_summary: "Project is progressing well",
      created_at: twoHoursAgo,
      updated_at: now
    },
    {
      task_id: "task_001",
      task_kind: "EXECUTION",
      parent_task_id: "task_root_001",
      root_task_id: "task_root_001",
      title: "Implement User Authentication",
      state: "DONE",
      creator_role: "pm",
      creator_session_id: "session-pm-001",
      owner_role: "backend_dev",
      owner_session: "session-backend-001",
      priority: 1,
      dependencies: [],
      write_set: ["/src/auth/login.ts", "/src/auth/middleware.ts"],
      acceptance: ["Users can login", "Sessions are managed correctly"],
      artifacts: ["/docs/auth.md"],
      alert: null,
      granted_at: twoHoursAgo,
      closed_at: hourAgo,
      last_summary: "Authentication system completed",
      created_at: twoHoursAgo,
      updated_at: hourAgo
    },
    {
      task_id: "task_002",
      task_kind: "EXECUTION",
      parent_task_id: "task_root_001",
      root_task_id: "task_root_001",
      title: "Build Dashboard UI",
      state: "IN_PROGRESS",
      creator_role: "pm",
      creator_session_id: "session-pm-001",
      owner_role: "frontend_dev",
      owner_session: "session-frontend-001",
      priority: 2,
      dependencies: ["task_001"],
      write_set: ["/src/components/Dashboard.tsx", "/src/styles/dashboard.css"],
      acceptance: ["Dashboard displays metrics", "Responsive design"],
      artifacts: [],
      alert: null,
      granted_at: hourAgo,
      closed_at: null,
      last_summary: "Working on the main dashboard layout",
      created_at: hourAgo,
      updated_at: now
    },
    {
      task_id: "task_003",
      task_kind: "EXECUTION",
      parent_task_id: "task_root_001",
      root_task_id: "task_root_001",
      title: "Write Integration Tests",
      state: "BLOCKED_DEP",
      creator_role: "pm",
      creator_session_id: "session-pm-001",
      owner_role: "qa",
      owner_session: "session-qa-001",
      priority: 3,
      dependencies: ["task_002"],
      write_set: ["/tests/integration/"],
      acceptance: ["All tests pass", "Coverage > 80%"],
      artifacts: [],
      alert: "Waiting for task_002 to complete",
      granted_at: hourAgo,
      closed_at: null,
      last_summary: "Blocked waiting for dashboard UI",
      created_at: hourAgo,
      updated_at: now
    },
    {
      task_id: "task_004",
      task_kind: "EXECUTION",
      parent_task_id: "task_root_001",
      root_task_id: "task_root_001",
      title: "API Rate Limiting",
      state: "READY",
      creator_role: "pm",
      creator_session_id: "session-pm-001",
      owner_role: "backend_dev",
      owner_session: null,
      priority: 2,
      dependencies: [],
      write_set: ["/src/middleware/rateLimit.ts"],
      acceptance: ["Rate limiting works", "Configurable limits"],
      artifacts: [],
      alert: null,
      granted_at: null,
      closed_at: null,
      last_summary: null,
      created_at: now,
      updated_at: now
    },
    {
      task_id: "task_005",
      task_kind: "EXECUTION",
      parent_task_id: "task_root_001",
      root_task_id: "task_root_001",
      title: "Fix Login Bug",
      state: "BLOCKED_DEP",
      creator_role: "qa",
      creator_session_id: "session-qa-001",
      owner_role: "backend_dev",
      owner_session: "session-backend-001",
      priority: 1,
      dependencies: [],
      write_set: [],
      acceptance: ["Login works on all browsers"],
      artifacts: [],
      alert: "Critical: Login fails on Safari",
      granted_at: hourAgo,
      closed_at: null,
      last_summary: "Investigating Safari-specific issue",
      created_at: hourAgo,
      updated_at: now
    }
  ],
  edges: [
    { from_task_id: "task_002", to_task_id: "task_001", relation: "DEPENDS_ON" },
    { from_task_id: "task_003", to_task_id: "task_002", relation: "DEPENDS_ON" }
  ],
  stats: { node_count: 6, edge_count: 2, external_dependency_edge_count: 0 }
};

export const mockTasks: TaskTreeNode[] = mockTaskTree.nodes;

export const mockLocks: LockRecord[] = [
  {
    lockId: "lock_001",
    lockKey: "/src/auth/login.ts",
    ownerSessionId: "session-backend-001",
    targetType: "file",
    purpose: "editing",
    ttlSeconds: 300,
    renewCount: 3,
    acquiredAt: hourAgo,
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    status: "active"
  },
  {
    lockId: "lock_002",
    lockKey: "/src/components/",
    ownerSessionId: "session-frontend-001",
    targetType: "dir",
    purpose: "refactoring",
    ttlSeconds: 600,
    renewCount: 1,
    acquiredAt: hourAgo,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    status: "active"
  },
  {
    lockId: "lock_003",
    lockKey: "/tests/integration/",
    ownerSessionId: "session-qa-001",
    targetType: "dir",
    purpose: "testing",
    ttlSeconds: 180,
    renewCount: 0,
    acquiredAt: twoHoursAgo,
    expiresAt: hourAgo,
    status: "expired"
  }
];

export const mockEvents: EventRecord[] = [
  {
    eventId: "evt_001",
    eventType: "TASK_CREATED",
    source: "pm",
    createdAt: twoHoursAgo,
    sessionId: "session-pm-001",
    payload: { taskId: "task_001", title: "Implement User Authentication" }
  },
  {
    eventId: "evt_002",
    eventType: "TASK_DISPATCHED",
    source: "orchestrator",
    createdAt: twoHoursAgo,
    sessionId: "session-backend-001",
    payload: { taskId: "task_001" }
  },
  {
    eventId: "evt_003",
    eventType: "TASK_COMPLETED",
    source: "backend_dev",
    createdAt: hourAgo,
    sessionId: "session-backend-001",
    payload: { taskId: "task_001", summary: "Authentication system completed" }
  },
  {
    eventId: "evt_004",
    eventType: "TASK_CREATED",
    source: "pm",
    createdAt: hourAgo,
    sessionId: "session-pm-001",
    payload: { taskId: "task_002", title: "Build Dashboard UI" }
  },
  {
    eventId: "evt_005",
    eventType: "LOCK_ACQUIRED",
    source: "backend_dev",
    createdAt: hourAgo,
    sessionId: "session-backend-001",
    payload: { lockKey: "/src/auth/login.ts" }
  },
  {
    eventId: "evt_006",
    eventType: "TASK_FAILED",
    source: "backend_dev",
    createdAt: now,
    sessionId: "session-backend-001",
    payload: { taskId: "task_005", error: "Safari compatibility issue" }
  }
];

export const mockTimeline: AgentIOTimelineItem[] = [
  {
    id: "io_001",
    projectId: "demo_project",
    sessionId: "session-pm-001",
    role: "pm",
    taskId: "task_001",
    direction: "outbound",
    messageType: "TASK_ASSIGN",
    summary: "Assign 'Implement User Authentication' to backend_dev",
    createdAt: twoHoursAgo
  },
  {
    id: "io_002",
    projectId: "demo_project",
    sessionId: "session-backend-001",
    role: "backend_dev",
    taskId: "task_001",
    direction: "inbound",
    messageType: "TASK_ASSIGN",
    summary: "Received task: Implement User Authentication",
    createdAt: twoHoursAgo
  },
  {
    id: "io_003",
    projectId: "demo_project",
    sessionId: "session-backend-001",
    role: "backend_dev",
    taskId: "task_001",
    direction: "outbound",
    messageType: "TASK_REPORT",
    summary: "Completed: Authentication system with JWT tokens",
    createdAt: hourAgo
  },
  {
    id: "io_004",
    projectId: "demo_project",
    sessionId: "session-pm-001",
    role: "pm",
    taskId: "task_002",
    direction: "outbound",
    messageType: "TASK_ASSIGN",
    summary: "Assign 'Build Dashboard UI' to frontend_dev",
    createdAt: hourAgo
  },
  {
    id: "io_005",
    projectId: "demo_project",
    sessionId: "session-frontend-001",
    role: "frontend_dev",
    taskId: "task_002",
    direction: "inbound",
    messageType: "TASK_ASSIGN",
    summary: "Received task: Build Dashboard UI",
    createdAt: hourAgo
  },
  {
    id: "io_006",
    projectId: "demo_project",
    sessionId: "session-pm-001",
    role: "pm",
    direction: "outbound",
    messageType: "CHAT",
    summary: "How's the progress on authentication?",
    createdAt: hourAgo
  },
  {
    id: "io_007",
    projectId: "demo_project",
    sessionId: "session-backend-001",
    role: "backend_dev",
    direction: "outbound",
    messageType: "CHAT",
    summary: "Auth is done, moving to rate limiting next",
    createdAt: now
  }
];

export const mockOrchestratorStatus: OrchestratorStatus = {
  enabled: true,
  running: true,
  intervalMs: 5000,
  totalDispatches: 47,
  pendingMessages: 3,
  dispatchedMessages: 42,
  failedDispatches: 2,
  lastTick: now
};

export const mockAgents: AgentDefinition[] = [
  {
    agentId: "pm",
    displayName: "Project Manager",
    prompt: "You are a project manager agent responsible for coordinating tasks and communicating with team members.",
    summary: "Owns requirement decomposition and collaboration routing.",
    skillList: ["default-core", "planning-pack"],
    updatedAt: twoHoursAgo,
    defaultCliTool: "codex",
    modelSelectionEnabled: true
  },
  {
    agentId: "backend_dev",
    displayName: "Backend Developer",
    prompt: "You are a backend developer agent specializing in Node.js, TypeScript, and database design.",
    summary: "Implements backend services, schema changes, and reliability fixes.",
    skillList: ["default-core"],
    updatedAt: hourAgo,
    defaultCliTool: "codex",
    defaultModelParams: { model: "gpt-4" }
  },
  {
    agentId: "frontend_dev",
    displayName: "Frontend Developer",
    prompt: "You are a frontend developer agent specializing in React, TypeScript, and modern CSS.",
    summary: "Builds product UI and interaction flows with frontend tooling.",
    skillList: ["default-core"],
    updatedAt: hourAgo,
    defaultCliTool: "trae",
    defaultModelParams: { model: "claude-3" }
  },
  {
    agentId: "qa",
    displayName: "QA Engineer",
    prompt: "You are a QA engineer agent responsible for testing and quality assurance.",
    summary: "Designs test plans and validates acceptance criteria.",
    skillList: ["qa-pack"],
    updatedAt: twoHoursAgo,
    defaultCliTool: "codex"
  }
];

export const mockSkills: SkillDefinition[] = [
  {
    schemaVersion: "1.0",
    skillId: "code-review",
    name: "Code Review",
    description: "Review patch risk and provide actionable findings.",
    license: "UNSPECIFIED",
    compatibility: "codex",
    sourceType: "codex",
    sourcePath: "C:/Users/spiri/.codex/skills/code-review",
    packagePath: "packages/code-review",
    entryFile: "SKILL.md",
    createdAt: twoHoursAgo,
    updatedAt: hourAgo
  },
  {
    schemaVersion: "1.0",
    skillId: "spec-writing",
    name: "Spec Writing",
    description: "Turn vague requests into executable requirement specs.",
    license: "UNSPECIFIED",
    compatibility: "opencode",
    sourceType: "opencode",
    sourcePath: "C:/Users/spiri/.config/opencode/skills/spec-writing",
    packagePath: "packages/spec-writing",
    entryFile: "SKILL.md",
    createdAt: twoHoursAgo,
    updatedAt: twoHoursAgo
  }
];

export const mockSkillLists: SkillListDefinition[] = [
  {
    schemaVersion: "1.0",
    listId: "default-core",
    displayName: "Default Core",
    description: "Base skills used by all implementation agents.",
    includeAll: false,
    skillIds: ["code-review"],
    createdAt: twoHoursAgo,
    updatedAt: hourAgo
  },
  {
    schemaVersion: "1.0",
    listId: "planning-pack",
    displayName: "Planning Pack",
    description: "Planning and specification toolkit.",
    includeAll: false,
    skillIds: ["spec-writing"],
    createdAt: twoHoursAgo,
    updatedAt: twoHoursAgo
  },
  {
    schemaVersion: "1.0",
    listId: "qa-pack",
    displayName: "QA Pack",
    description: "Quality and verification skills.",
    includeAll: true,
    skillIds: [],
    createdAt: hourAgo,
    updatedAt: hourAgo
  }
];

export const mockAgentTemplates: { builtInItems: AgentTemplateDefinition[]; customItems: AgentTemplateDefinition[] } = {
  builtInItems: [
    {
      templateId: "developer",
      displayName: "Developer",
      prompt: "You are a software developer agent. Write clean, maintainable code following best practices.",
      source: "built-in"
    },
    {
      templateId: "reviewer",
      displayName: "Code Reviewer",
      prompt: "You are a code reviewer agent. Review code for bugs, security issues, and style violations.",
      source: "built-in"
    },
    {
      templateId: "architect",
      displayName: "Software Architect",
      prompt: "You are a software architect agent. Design system architecture and make technical decisions.",
      source: "built-in"
    }
  ],
  customItems: [
    {
      templateId: "senior_backend",
      displayName: "Senior Backend Dev",
      prompt: "You are a senior backend developer with 10+ years of experience. Focus on scalability and performance.",
      source: "custom",
      basedOnTemplateId: "developer"
    }
  ]
};

export const mockProjectTemplates: TemplateDefinition[] = [
  { templateId: "default", name: "Default Project", description: "Standard project with PM, Dev, and QA agents" },
  { templateId: "solo", name: "Solo Developer", description: "Single developer project" },
  { templateId: "fullstack", name: "Full Stack Team", description: "Frontend, backend, and QA agents" }
];

export const mockOrchestratorSettings = {
  project_id: "demo_project",
  auto_dispatch_enabled: true,
  auto_dispatch_remaining: 53,
  hold_enabled: false,
  reminder_mode: "backoff" as const,
  updated_at: hourAgo
};
