import type { ProjectRecord } from "../domain/models.js";

export const DISCUSS_DEFAULT_MAX_ROUNDS = 20;
export const DISCUSS_HARD_MAX_ROUNDS = 500;
export const DISCUSS_MAX_REQUESTS_PER_DIALOGUE = 1;

export interface DiscussPromptPolicyText {
  oneRequestPerDialogue: string;
  roundLimit: string;
  roundEscalation: string;
}

export function clampDiscussRounds(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DISCUSS_DEFAULT_MAX_ROUNDS;
  }
  return Math.min(Math.max(Math.floor(raw), 1), DISCUSS_HARD_MAX_ROUNDS);
}

export function resolveDiscussRoundLimit(
  project: Pick<ProjectRecord, "routeDiscussRounds">,
  fromAgent: string,
  toAgent: string
): number {
  const from = fromAgent.trim();
  const to = toAgent.trim();
  if (!from || !to) {
    return DISCUSS_DEFAULT_MAX_ROUNDS;
  }
  const configured = project.routeDiscussRounds?.[from]?.[to];
  return clampDiscussRounds(typeof configured === "number" ? configured : undefined);
}

export function getDiscussPromptPolicyText(): DiscussPromptPolicyText {
  return {
    oneRequestPerDialogue: `in one dialogue round, submit at most ${DISCUSS_MAX_REQUESTS_PER_DIALOGUE} TASK_DISCUSS_REQUEST; merge open questions into a single request before sending.`,
    roundLimit: `max ${DISCUSS_DEFAULT_MAX_ROUNDS} rounds per discuss thread`,
    roundEscalation: `if still unresolved at round ${DISCUSS_DEFAULT_MAX_ROUNDS}, send TASK_DISCUSS_CLOSED and continue with explicit assumptions or mark BLOCKED_DEP.`
  };
}
