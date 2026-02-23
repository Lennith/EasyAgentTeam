# server/src/minimax

Embedded AI agent SDK. 18 files across 6 subdirectories.

## OVERVIEW

Self-contained agent runtime with LLM client, tools, sessions, MCP, compression.

## STRUCTURE

```
minimax/
├── index.ts          # Main exports, MiniMaxAgent class
├── types.ts          # Type definitions
├── agent/            # Agent logic
│   └── Agent.ts
├── llm/              # LLM client
│   └── LLMClient.ts
├── tools/            # Tool registry and implementations
│   ├── Tool.ts, ToolRegistry.ts
│   ├── FileTools.ts, ShellTool.ts, NoteTool.ts
│   ├── PermissionManager.ts
│   └── index.ts (barrel)
├── storage/          # Session storage
│   ├── SessionStorage.ts
│   └── JSONLWriter.ts
├── session/          # Session management
│   └── SessionManager.ts
├── mcp/              # MCP connector
│   └── MCPConnector.ts
├── skills/           # Skill loading
│   └── SkillLoader.ts
└── compression/      # Context compression
    ├── ContextCompressor.ts
    └── prompts.ts
```

## CONVENTIONS

- ES modules with `.js` extension imports
- Tool implementations extend base `Tool` class
- Session storage uses JSONL format

## ANTI-PATTERNS

- NEVER use Unix commands (bash/sh/zsh) — Windows only
- NEVER use command chaining (`&&`, `||`, `;`)
- DO NOT call directly from app.ts — route through services layer
