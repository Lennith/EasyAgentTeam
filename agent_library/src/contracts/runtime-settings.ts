import { z } from "zod";
import {
  nullableStringPatch,
  optionalString,
  readInteger,
  ReasoningEffortSchema,
  requiredString,
  unknownRecord
} from "./common.js";

export const ThemeSchema = z.enum(["dark", "vibrant", "lively"]);

export const AuthLoginRequestSchema = z.object({
  password: requiredString,
  remote_password: optionalString,
  remotePassword: optionalString
});

export const AuthStatusResponseSchema = z.object({
  remote_password_enabled: z.boolean(),
  authenticated: z.boolean()
});

export const AuthLoginResponseSchema = z.object({
  token: z.string().nullable(),
  remote_password_enabled: z.boolean()
});

const McpServerConfigSchema = z
  .object({
    name: requiredString,
    type: z.enum(["stdio", "sse", "http"]),
    command: optionalString,
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: optionalString,
    headers: z.record(z.string(), z.string()).optional(),
    disabled: z.boolean().optional(),
    connectTimeout: z.number().optional(),
    executeTimeout: z.number().optional()
  })
  .passthrough();

export const RuntimeSettingsPatchRequestSchema = z
  .object({
    theme: ThemeSchema.optional(),
    security: z
      .object({
        remote_password: nullableStringPatch,
        remotePassword: nullableStringPatch
      })
      .optional(),
    providers: z
      .object({
        codex: z
          .object({
            cli_command: optionalString,
            cliCommand: optionalString,
            model: optionalString,
            reasoning_effort: ReasoningEffortSchema.optional(),
            reasoningEffort: ReasoningEffortSchema.optional()
          })
          .optional(),
        dpagent: z
          .object({
            cli_command: optionalString,
            cliCommand: optionalString
          })
          .optional(),
        minimax: z
          .object({
            api_key: nullableStringPatch,
            apiKey: nullableStringPatch,
            api_base: nullableStringPatch,
            apiBase: nullableStringPatch,
            model: optionalString,
            session_dir: optionalString,
            sessionDir: optionalString,
            mcp_servers: z.array(McpServerConfigSchema).optional(),
            mcpServers: z.array(McpServerConfigSchema).optional(),
            max_steps: z.union([z.number(), z.string()]).optional(),
            maxSteps: z.union([z.number(), z.string()]).optional(),
            token_limit: z.union([z.number(), z.string()]).optional(),
            tokenLimit: z.union([z.number(), z.string()]).optional(),
            max_output_tokens: z.union([z.number(), z.string()]).optional(),
            maxOutputTokens: z.union([z.number(), z.string()]).optional(),
            shell_timeout: z.union([z.number(), z.string()]).optional(),
            shellTimeout: z.union([z.number(), z.string()]).optional(),
            shell_output_idle_timeout: z.union([z.number(), z.string()]).optional(),
            shellOutputIdleTimeout: z.union([z.number(), z.string()]).optional(),
            shell_max_run_time: z.union([z.number(), z.string()]).optional(),
            shellMaxRunTime: z.union([z.number(), z.string()]).optional(),
            shell_max_output_size: z.union([z.number(), z.string()]).optional(),
            shellMaxOutputSize: z.union([z.number(), z.string()]).optional()
          })
          .optional()
      })
      .optional()
  })
  .passthrough()
  .transform((body) => ({
    theme: body.theme,
    security:
      body.security && (body.security.remote_password !== undefined || body.security.remotePassword !== undefined)
        ? {
            remotePassword: body.security.remote_password ?? body.security.remotePassword ?? null
          }
        : undefined,
    providers: body.providers
      ? {
          ...(body.providers.codex
            ? {
                codex: {
                  cliCommand: body.providers.codex.cli_command ?? body.providers.codex.cliCommand,
                  model: body.providers.codex.model,
                  reasoningEffort: body.providers.codex.reasoning_effort ?? body.providers.codex.reasoningEffort
                }
              }
            : {}),
          ...(body.providers.dpagent
            ? {
                dpagent: {
                  cliCommand: body.providers.dpagent.cli_command ?? body.providers.dpagent.cliCommand
                }
              }
            : {}),
          ...(body.providers.minimax
            ? {
                minimax: {
                  ...(body.providers.minimax.api_key !== undefined || body.providers.minimax.apiKey !== undefined
                    ? { apiKey: body.providers.minimax.api_key ?? body.providers.minimax.apiKey ?? null }
                    : {}),
                  ...(body.providers.minimax.api_base !== undefined || body.providers.minimax.apiBase !== undefined
                    ? { apiBase: body.providers.minimax.api_base ?? body.providers.minimax.apiBase ?? null }
                    : {}),
                  model: body.providers.minimax.model,
                  sessionDir: body.providers.minimax.session_dir ?? body.providers.minimax.sessionDir,
                  mcpServers: body.providers.minimax.mcp_servers ?? body.providers.minimax.mcpServers,
                  maxSteps: readInteger(body.providers.minimax.max_steps ?? body.providers.minimax.maxSteps),
                  tokenLimit: readInteger(body.providers.minimax.token_limit ?? body.providers.minimax.tokenLimit),
                  maxOutputTokens: readInteger(
                    body.providers.minimax.max_output_tokens ?? body.providers.minimax.maxOutputTokens
                  ),
                  shellTimeout: readInteger(
                    body.providers.minimax.shell_timeout ?? body.providers.minimax.shellTimeout
                  ),
                  shellOutputIdleTimeout: readInteger(
                    body.providers.minimax.shell_output_idle_timeout ?? body.providers.minimax.shellOutputIdleTimeout
                  ),
                  shellMaxRunTime: readInteger(
                    body.providers.minimax.shell_max_run_time ?? body.providers.minimax.shellMaxRunTime
                  ),
                  shellMaxOutputSize: readInteger(
                    body.providers.minimax.shell_max_output_size ?? body.providers.minimax.shellMaxOutputSize
                  )
                }
              }
            : {})
        }
      : undefined,
    rawBody: body as Record<string, unknown>
  }));

export const RuntimeSettingsApiResponseSchema = unknownRecord;

export type AuthLoginPublicRequest = z.input<typeof AuthLoginRequestSchema>;
export type AuthStatusResponse = z.infer<typeof AuthStatusResponseSchema>;
export type AuthLoginResponse = z.infer<typeof AuthLoginResponseSchema>;
export type RuntimeSettingsPatchPublicRequest = z.input<typeof RuntimeSettingsPatchRequestSchema>;
export type RuntimeSettingsPatchContract = z.infer<typeof RuntimeSettingsPatchRequestSchema>;
