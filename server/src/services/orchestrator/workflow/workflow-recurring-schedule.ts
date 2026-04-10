export interface WorkflowSchedulePattern {
  expression: string;
  month: number | null;
  day: number | null;
  hour: number;
  minute: number | null;
}

const WORKFLOW_SCHEDULE_RE = /^(XX|0[1-9]|1[0-2])-(XX|0[1-9]|[12][0-9]|3[01]) ([01][0-9]|2[0-3]):(XX|[0-5][0-9])$/i;

function normalizeTwoDigitToken(value: string): string {
  return value.trim().toUpperCase();
}

function parseToken(value: string): number | null {
  const normalized = normalizeTwoDigitToken(value);
  if (normalized === "XX") {
    return null;
  }
  return Number.parseInt(normalized, 10);
}

function toMinuteCursor(from: Date): Date {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  if (cursor.getTime() < from.getTime()) {
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return cursor;
}

export function parseWorkflowScheduleExpression(raw: string | null | undefined): WorkflowSchedulePattern | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim().toUpperCase();
  const match = trimmed.match(WORKFLOW_SCHEDULE_RE);
  if (!match) {
    return null;
  }
  const [, monthToken, dayToken, hourToken, minuteToken] = match;
  const month = parseToken(monthToken);
  const day = parseToken(dayToken);
  const hour = Number.parseInt(hourToken, 10);
  const minute = parseToken(minuteToken);
  return {
    expression: `${monthToken}-${dayToken} ${hourToken}:${minuteToken}`.toUpperCase(),
    month,
    day,
    hour,
    minute
  };
}

export function matchesWorkflowSchedulePattern(pattern: WorkflowSchedulePattern, now: Date): boolean {
  if (pattern.month !== null && now.getMonth() + 1 !== pattern.month) {
    return false;
  }
  if (pattern.day !== null && now.getDate() !== pattern.day) {
    return false;
  }
  if (now.getHours() !== pattern.hour) {
    return false;
  }
  if (pattern.minute !== null && now.getMinutes() !== pattern.minute) {
    return false;
  }
  return true;
}

export function resolveWorkflowScheduleWindowRange(
  pattern: WorkflowSchedulePattern,
  now: Date
): { windowStartAt: string; windowEndAt: string } | null {
  if (!matchesWorkflowSchedulePattern(pattern, now)) {
    return null;
  }
  if (pattern.minute === null) {
    const start = new Date(now.getTime());
    start.setMinutes(0, 0, 0);
    const end = new Date(start.getTime());
    end.setHours(end.getHours() + 1);
    return {
      windowStartAt: start.toISOString(),
      windowEndAt: end.toISOString()
    };
  }
  const start = new Date(now.getTime());
  start.setSeconds(0, 0);
  const end = new Date(start.getTime());
  end.setMinutes(end.getMinutes() + 1);
  return {
    windowStartAt: start.toISOString(),
    windowEndAt: end.toISOString()
  };
}

export function buildWorkflowScheduleWindowKey(pattern: WorkflowSchedulePattern, now: Date): string | null {
  if (!matchesWorkflowSchedulePattern(pattern, now)) {
    return null;
  }
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hour = String(now.getHours()).padStart(2, "0");
  if (pattern.minute === null) {
    const minute = String(now.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${minute}`;
  }
  const minute = String(pattern.minute).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

export function computeNextWorkflowScheduleTriggerAt(
  pattern: WorkflowSchedulePattern,
  from: Date = new Date()
): string | null {
  const cursor = toMinuteCursor(from);
  const maxProbeMinutes = 366 * 24 * 60;
  for (let index = 0; index <= maxProbeMinutes; index += 1) {
    if (matchesWorkflowSchedulePattern(pattern, cursor)) {
      return cursor.toISOString();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
