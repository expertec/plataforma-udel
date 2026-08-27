export function normalizeProgramLevelText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function isExamOptionalProgram(value: string | null | undefined): boolean {
  const normalized = normalizeProgramLevelText(value ?? "");
  if (!normalized) return false;
  return (
    normalized.includes("maestria") ||
    normalized.includes("master") ||
    normalized.includes("diplomado")
  );
}
