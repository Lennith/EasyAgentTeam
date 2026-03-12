import { useState } from "react";

export type Language = "en" | "zh";

interface Translations {
  home: string;
  projects: string;
  agents: string;
  debug: string;
  settings: string;
  loading: string;
  error: string;
  retry: string;
  refresh: string;
  save: string;
  saving: string;
  saved: string;
  cancel: string;
  delete: string;
  deleting: string;
  create: string;
  update: string;
  search: string;
  noData: string;
  confirm: string;
  projectName: string;
  projectId: string;
  workspacePath: string;
  createProject: string;
  templates: string;
  selectTemplate: string;
  agentRole: string;
  model: string;
  description: string;
  modelRuntime: string;
  tool: string;
  agentModelConfig: string;
  agentId: string;
  language: string;
  switchLanguage: string;
  english: string;
  chinese: string;
  agentIO: string;
  agentChat: string;
  send: string;
  interrupt: string;
  selectAgent: string;
  enterPrompt: string;
  taskboard: string;
  lockManager: string;
  chatTimeline: string;
  activityTimeline: string;
  chatMessages: string;
  createTask: string;
  updateTask: string;
  taskDetails: string;
  taskId: string;
  taskTitle: string;
  taskSummary: string;
  taskDescription: string;
  taskState: string;
  taskKind: string;
  writeSet: string;
  dependencies: string;
  acceptance: string;
  artifacts: string;
  mode: string;
  sessionManager: string;
  dispatchSession: string;
  dispatchMessage: string;
  terminateSession: string;
  spawnSession: string;
  pendingDispatch: string;
  recentEvents: string;
  latestPrompt: string;
  newAgent: string;
  displayName: string;
  prompt: string;
  newTemplate: string;
  templateId: string;
  projectViews: string;
  timeline: string;
  chat: string;
  debugSessions: string;
  debugSessionPrompts: string;
  loadingSessions: string;
  dismissSession: string;
  sessions: string;
  loadingAgentRegistry: string;
  loadingAgentTemplates: string;
  noAgents: string;
  loadingSettings: string;
  codex: string;
  trae: string;
  createdAt: string;
  updatedAt: string;
  loadingTemplates: string;
  creatingProject: string;
  availableAgents: string;
  clarificationRounds: string;
  loadingProject: string;
  deleteProject: string;
  confirmDeleteProject: string;
  orchestratorHealth: string;
  orchestratorEnabled: string;
  orchestratorRunning: string;
  orchestratorInterval: string;
  autoDispatchLimit: string;
  autoDispatchUsed: string;
  projectTotalDispatch: string;
  pendingMessages: string;
  dispatchedMessages: string;
  failedDispatches: string;
  lastTick: string;
  taskTree: string;
  projectSettings: string;
  orchestratorSettings: string;
  autoDispatch: string;
  autoDispatchEnabledDesc: string;
  autoDispatchDisabledDesc: string;
  autoDispatchRemaining: string;
  autoDispatchRemainingDesc: string;
  enabled: string;
  disabled: string;
  projectInfo: string;
  noProjectInfo: string;
  taskRoot: string;
  taskExecution: string;
  taskPlanned: string;
  taskReady: string;
  taskDispatched: string;
  taskInProgress: string;
  taskBlockedDep: string;
  taskMayBeDone: string;
  taskDone: string;
  taskCanceled: string;
  taskTodo: string;
  taskDoing: string;
  taskWaitingNext: string;
  taskBlocked: string;
  taskNeedClarification: string;
  taskFailed: string;
  ownerRole: string;
  ownerSession: string;
  creatorRole: string;
  parentTask: string;
  fromAgent: string;
  rootTask: string;
  priority: string;
  grantedAt: string;
  closedAt: string;
  routingConfig: string;
  routingMatrix: string;
  allowedRoutes: string;
  clarificationRoundLimit: string;
  agentSettings: string;
  modelConfig: string;
  effort: string;
  lowEffort: string;
  mediumEffort: string;
  highEffort: string;
  settingsSaved: string;
  teamConfig: string;
  eventTimeline: string;
  projectOverview: string;
  selectProject: string;
  noProjects: string;
  agentSessions: string;
  agentRegistry: string;
  agentTemplates: string;
  helpText: string;
  codexOutput: string;
  teams: string;
  teamList: string;
  newTeam: string;
  teamName: string;
  teamId: string;
  teamMembers: string;
  memberCount: string;
  messageRouting: string;
  taskRouting: string;
  selectTeam: string;
  copyFromProject: string;
  teamCreated: string;
  teamUpdated: string;
  teamDeleted: string;
  confirmDeleteTeam: string;
  noTeams: string;
  loadingTeams: string;
  workflow: string;
  workflowTemplates: string;
  workflowRuns: string;
  newWorkflowTemplate: string;
  newWorkflowRun: string;
  skills: string;
  skillLibrary: string;
  skillLists: string;
}

const translations: Record<Language, Translations> = {
  en: {
    home: "Home",
    projects: "Projects",
    agents: "Agents",
    debug: "Debug",
    settings: "Settings",
    loading: "Loading...",
    error: "Error",
    retry: "Retry",
    refresh: "Refresh",
    save: "Save",
    saving: "Saving...",
    saved: "Saved.",
    cancel: "Cancel",
    delete: "Delete",
    deleting: "Deleting...",
    create: "Create",
    update: "Update",
    search: "Search",
    noData: "No data available",
    confirm: "Confirm",
    projectName: "Project Name",
    projectId: "Project ID",
    workspacePath: "Workspace Path",
    createProject: "Create Project",
    templates: "Templates",
    selectTemplate: "Select a template...",
    agentRole: "Agent Role",
    model: "Model",
    description: "Description",
    modelRuntime: "Model Runtime",
    tool: "Tool",
    agentModelConfig: "Agent Model Config",
    agentId: "Agent ID",
    language: "Language",
    switchLanguage: "Switch Language",
    english: "English",
    chinese: "中文",
    agentIO: "Agent I/O",
    agentChat: "Agent Chat",
    send: "Send",
    interrupt: "Interrupt",
    selectAgent: "Select an agent to start chatting",
    enterPrompt: "Enter prompt...",
    taskboard: "Taskboard",
    lockManager: "Lock Manager",
    chatTimeline: "Chat Timeline",
    activityTimeline: "Activity Timeline",
    chatMessages: "Dispatched Messages",
    createTask: "Create Task",
    updateTask: "Update Task",
    taskDetails: "Task Details",
    taskId: "Task ID",
    taskTitle: "Title",
    taskSummary: "Summary",
    taskDescription: "Description",
    taskState: "State",
    taskKind: "Kind",
    writeSet: "Write Set",
    dependencies: "Dependencies",
    acceptance: "Acceptance Criteria",
    artifacts: "Artifacts",
    mode: "Mode",
    sessionManager: "Session Manager",
    dispatchSession: "Dispatch Session",
    dispatchMessage: "Dispatch Message",
    terminateSession: "Terminate Session",
    spawnSession: "Spawn Session",
    pendingDispatch: "Pending Dispatch",
    recentEvents: "Recent Events",
    latestPrompt: "Latest Prompt",
    newAgent: "New Agent",
    displayName: "Display Name",
    prompt: "Prompt",
    newTemplate: "New Template",
    templateId: "Template ID",
    projectViews: "Project Views",
    timeline: "Timeline",
    chat: "Chat",
    debugSessions: "Debug Sessions",
    debugSessionPrompts: "Session Prompts",
    loadingSessions: "Loading sessions...",
    dismissSession: "Dismiss",
    sessions: "Sessions",
    loadingAgentRegistry: "Loading agent registry...",
    loadingAgentTemplates: "Loading agent templates...",
    noAgents: "No agents registered yet",
    loadingSettings: "Loading settings...",
    codex: "Codex",
    trae: "Trae",
    createdAt: "Created At",
    updatedAt: "Updated At",
    loadingTemplates: "Loading templates...",
    creatingProject: "Creating project...",
    availableAgents: "Available Agents",
    clarificationRounds: "Clarification Rounds",
    loadingProject: "Loading project...",
    deleteProject: "Delete Project",
    confirmDeleteProject: "Delete project",
    orchestratorHealth: "Orchestrator Health",
    orchestratorEnabled: "Enabled",
    orchestratorRunning: "Running",
    orchestratorInterval: "Interval (ms)",
    autoDispatchLimit: "Auto Dispatch Limit",
    autoDispatchUsed: "Auto Dispatch Used",
    projectTotalDispatch: "Total Dispatches",
    pendingMessages: "Pending",
    dispatchedMessages: "Dispatched",
    failedDispatches: "Failed",
    lastTick: "Last Tick",
    taskTree: "Task Tree",
    projectSettings: "Project Settings",
    orchestratorSettings: "Orchestrator Settings",
    autoDispatch: "Auto Dispatch",
    autoDispatchEnabledDesc: "Automatic dispatch is enabled. Tasks will be dispatched automatically.",
    autoDispatchDisabledDesc: "Automatic dispatch is disabled. Manual dispatch required.",
    autoDispatchRemaining: "Remaining Dispatches",
    autoDispatchRemainingDesc:
      "Number of automatic dispatches remaining. Only successful task dispatches consume this quota.",
    enabled: "Enabled",
    disabled: "Disabled",
    projectInfo: "Project Info",
    noProjectInfo: "No project information available",
    taskRoot: "Root",
    taskExecution: "Execution",
    taskPlanned: "Planned",
    taskReady: "Ready",
    taskDispatched: "Dispatched",
    taskInProgress: "In Progress",
    taskBlockedDep: "Blocked (Dependency)",
    taskMayBeDone: "May Be Done",
    taskDone: "Done",
    taskCanceled: "Canceled",
    taskTodo: "TODO",
    taskDoing: "Doing",
    taskWaitingNext: "Waiting Next",
    taskBlocked: "Blocked",
    taskNeedClarification: "Need Clarification",
    taskFailed: "Failed",
    ownerRole: "Owner Role",
    ownerSession: "Owner Session",
    creatorRole: "Creator Role",
    parentTask: "Parent Task",
    fromAgent: "From Agent",
    rootTask: "Root Task",
    priority: "Priority",
    grantedAt: "Granted At",
    closedAt: "Closed At",
    routingConfig: "Routing Config",
    routingMatrix: "Routing Matrix",
    allowedRoutes: "Allowed Routes",
    clarificationRoundLimit: "Clarification Round Limit",
    agentSettings: "Agent Settings",
    modelConfig: "Model Config",
    effort: "Effort",
    lowEffort: "Low",
    mediumEffort: "Medium",
    highEffort: "High",
    settingsSaved: "Settings saved successfully.",
    teamConfig: "Team Config",
    eventTimeline: "Event Timeline",
    projectOverview: "Project Overview",
    selectProject: "Select a project",
    noProjects: "No projects found",
    agentSessions: "Agent Sessions",
    agentRegistry: "Agent Registry",
    agentTemplates: "Agent Templates",
    helpText: "Configure CLI commands for running agents.",
    codexOutput: "Codex Output",
    teams: "Teams",
    teamList: "Team List",
    newTeam: "New Team",
    teamName: "Team Name",
    teamId: "Team ID",
    teamMembers: "Members & Models",
    memberCount: "Members",
    messageRouting: "Message Routing",
    taskRouting: "Task Routing",
    selectTeam: "Select a team...",
    copyFromProject: "Copy from Project",
    teamCreated: "Team created successfully.",
    teamUpdated: "Team updated successfully.",
    teamDeleted: "Team deleted successfully.",
    confirmDeleteTeam: "Delete team",
    noTeams: "No teams found",
    loadingTeams: "Loading teams...",
    workflow: "Workflow",
    workflowTemplates: "Workflow Templates",
    workflowRuns: "Workflow Runs",
    newWorkflowTemplate: "New Template",
    newWorkflowRun: "New Run",
    skills: "Skills",
    skillLibrary: "Library",
    skillLists: "Lists"
  },
  zh: {
    home: "首页",
    projects: "项目",
    agents: "智能体",
    debug: "调试",
    settings: "设置",
    loading: "加载中...",
    error: "错误",
    retry: "重试",
    refresh: "刷新",
    save: "保存",
    saving: "保存中...",
    saved: "已保存。",
    cancel: "取消",
    delete: "删除",
    deleting: "删除中...",
    create: "创建",
    update: "更新",
    search: "搜索",
    noData: "暂无数据",
    confirm: "确认",
    projectName: "项目名称",
    projectId: "项目ID",
    workspacePath: "工作空间路径",
    createProject: "创建项目",
    templates: "模板",
    selectTemplate: "选择模板...",
    agentRole: "智能体角色",
    model: "模型",
    description: "描述",
    modelRuntime: "模型运行时",
    tool: "工具",
    agentModelConfig: "智能体模型配置",
    agentId: "智能体ID",
    language: "语言",
    switchLanguage: "切换语言",
    english: "English",
    chinese: "中文",
    agentIO: "智能体I/O",
    agentChat: "智能体聊天",
    send: "发送",
    interrupt: "打断",
    selectAgent: "选择一个智能体开始聊天",
    enterPrompt: "输入提示词...",
    taskboard: "任务看板",
    lockManager: "锁管理器",
    chatTimeline: "聊天时间线",
    activityTimeline: "活动时间线",
    chatMessages: "已派发消息",
    createTask: "创建任务",
    updateTask: "更新任务",
    taskDetails: "任务详情",
    taskId: "任务ID",
    taskTitle: "标题",
    taskSummary: "摘要",
    taskDescription: "描述",
    taskState: "状态",
    taskKind: "类型",
    writeSet: "写入集",
    dependencies: "依赖",
    acceptance: "验收标准",
    artifacts: "产出物",
    mode: "模式",
    sessionManager: "会话管理器",
    dispatchSession: "派发会话",
    dispatchMessage: "派发消息",
    terminateSession: "终止会话",
    spawnSession: "生成会话",
    pendingDispatch: "待派发",
    recentEvents: "最近事件",
    latestPrompt: "最新提示词",
    newAgent: "新建智能体",
    displayName: "显示名称",
    prompt: "提示词",
    newTemplate: "新建模板",
    templateId: "模板ID",
    projectViews: "项目视图",
    timeline: "时间线",
    chat: "聊天",
    debugSessions: "调试会话",
    debugSessionPrompts: "会话提示词",
    loadingSessions: "加载会话...",
    dismissSession: "关闭",
    sessions: "会话",
    loadingAgentRegistry: "加载智能体注册表...",
    loadingAgentTemplates: "加载智能体模板...",
    noAgents: "暂无注册的智能体",
    loadingSettings: "加载设置...",
    codex: "Codex",
    trae: "Trae",
    createdAt: "创建时间",
    updatedAt: "更新时间",
    loadingTemplates: "加载模板...",
    creatingProject: "创建项目中...",
    availableAgents: "可用智能体",
    clarificationRounds: "澄清轮次",
    loadingProject: "加载项目...",
    deleteProject: "删除项目",
    confirmDeleteProject: "删除项目",
    orchestratorHealth: "编排器健康状态",
    orchestratorEnabled: "已启用",
    orchestratorRunning: "运行中",
    orchestratorInterval: "间隔 (ms)",
    autoDispatchLimit: "自动派发限制",
    autoDispatchUsed: "已用派发次数",
    projectTotalDispatch: "总派发次数",
    pendingMessages: "待处理",
    dispatchedMessages: "已派发",
    failedDispatches: "失败",
    lastTick: "上次Tick",
    taskTree: "任务树",
    projectSettings: "项目设置",
    orchestratorSettings: "编排器设置",
    autoDispatch: "自动派发",
    autoDispatchEnabledDesc: "自动派发已启用。任务将被自动派发。",
    autoDispatchDisabledDesc: "自动派发已禁用。需要手动派发。",
    autoDispatchRemaining: "剩余派发次数",
    autoDispatchRemainingDesc: "剩余自动派发次数。只有成功的任务派发才会消耗此配额。",
    enabled: "已启用",
    disabled: "已禁用",
    projectInfo: "项目信息",
    noProjectInfo: "暂无项目信息",
    taskRoot: "根任务",
    taskExecution: "执行任务",
    taskPlanned: "计划中",
    taskReady: "就绪",
    taskDispatched: "已派发",
    taskInProgress: "进行中",
    taskBlockedDep: "依赖阻塞",
    taskMayBeDone: "可能完成",
    taskDone: "完成",
    taskCanceled: "已取消",
    taskTodo: "待办",
    taskDoing: "执行中",
    taskWaitingNext: "等待下一步",
    taskBlocked: "阻塞",
    taskNeedClarification: "需要澄清",
    taskFailed: "失败",
    ownerRole: "负责人角色",
    ownerSession: "负责人会话",
    creatorRole: "创建者角色",
    parentTask: "父任务",
    fromAgent: "来源智能体",
    rootTask: "根任务",
    priority: "优先级",
    grantedAt: "授权时间",
    closedAt: "关闭时间",
    routingConfig: "路由配置",
    routingMatrix: "路由矩阵",
    allowedRoutes: "允许路由",
    clarificationRoundLimit: "澄清轮次限制",
    agentSettings: "智能体设置",
    modelConfig: "模型配置",
    effort: "努力程度",
    lowEffort: "低",
    mediumEffort: "中",
    highEffort: "高",
    settingsSaved: "设置已保存。",
    teamConfig: "团队配置",
    eventTimeline: "事件时间线",
    projectOverview: "项目概览",
    selectProject: "选择项目",
    noProjects: "暂无项目",
    agentSessions: "智能体会话",
    agentRegistry: "智能体注册",
    agentTemplates: "智能体模板",
    helpText: "配置运行智能体的CLI命令。",
    codexOutput: "Codex 输出",
    teams: "团队",
    teamList: "团队列表",
    newTeam: "新建团队",
    teamName: "团队名称",
    teamId: "团队ID",
    teamMembers: "成员与模型",
    memberCount: "成员数",
    messageRouting: "消息路由",
    taskRouting: "任务路由",
    selectTeam: "选择团队...",
    copyFromProject: "从项目复制",
    teamCreated: "团队创建成功。",
    teamUpdated: "团队更新成功。",
    teamDeleted: "团队删除成功。",
    confirmDeleteTeam: "删除团队",
    noTeams: "暂无团队",
    loadingTeams: "加载团队...",
    workflow: "任务流",
    workflowTemplates: "任务流模板",
    workflowRuns: "任务流运行",
    newWorkflowTemplate: "新建模板",
    newWorkflowRun: "新建运行",
    skills: "技能",
    skillLibrary: "库",
    skillLists: "列表"
  }
};

export function useTranslation(): Translations {
  const [lang] = useState<Language>(() => {
    try {
      const stored = localStorage.getItem("dashboard_lang");
      if (stored === "en" || stored === "zh") return stored;
    } catch {}
    return "en";
  });

  return translations[lang];
}
