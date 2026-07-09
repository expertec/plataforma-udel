export const DEFAULT_FORUM_POINT_VALUE = 5;
export const MAX_FORUM_POINT_VALUE = 100;

export function normalizeForumPointValue(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number(typeof value === "string" ? value.trim().replace(",", ".") : value);

  if (!Number.isFinite(parsed)) return DEFAULT_FORUM_POINT_VALUE;

  const bounded = Math.max(0, Math.min(parsed, MAX_FORUM_POINT_VALUE));
  return Math.round(bounded * 100) / 100;
}

export function parseForumPointValueInput(value: string): number | null {
  const normalizedText = value.trim().replace(",", ".");
  if (!normalizedText) return DEFAULT_FORUM_POINT_VALUE;
  const parsed = Number(normalizedText);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > MAX_FORUM_POINT_VALUE) return null;
  return normalizeForumPointValue(parsed);
}

export function formatForumPointValue(value: number): string {
  const normalized = normalizeForumPointValue(value);
  if (Number.isInteger(normalized)) return String(normalized);
  return normalized.toFixed(2).replace(/\.?0+$/, "");
}
