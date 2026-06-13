export const normalizeSearchText = (value: unknown): string =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export const includesNormalized = (haystack: unknown, needle: unknown): boolean =>
  normalizeSearchText(haystack).includes(normalizeSearchText(needle));
