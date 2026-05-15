export const ACTIVE_STUDENT_STATUS = "active";
export const ARCHIVED_STUDENT_STATUS = "archived";

const BLOCKED_STUDENT_STATUSES = new Set([
  ARCHIVED_STUDENT_STATUS,
  "deleted",
  "inactive",
  "dropped",
  "cancelled",
  "blocked",
  "suspended",
  "baja",
]);

export function normalizeStudentStatus(
  value: unknown,
  fallback: string = ACTIVE_STUDENT_STATUS,
): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "activo") return ACTIVE_STUDENT_STATUS;
  return normalized;
}

export function isStudentStatusActive(value: unknown): boolean {
  return !BLOCKED_STUDENT_STATUSES.has(normalizeStudentStatus(value));
}

export function isStudentStatusBlocked(value: unknown): boolean {
  return !isStudentStatusActive(value);
}
