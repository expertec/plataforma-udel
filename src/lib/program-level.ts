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
    normalized.includes("certificacion") ||
    normalized.includes("certificaciones") ||
    normalized.includes("maestria") ||
    normalized.includes("master") ||
    normalized.includes("diplomado")
  );
}

function normalizeCourseNameForExamPolicy(value: string | null | undefined): string {
  return normalizeProgramLevelText(value ?? "")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ");
}

export function isExamOptionalCourseName(value: string | null | undefined): boolean {
  const normalized = normalizeCourseNameForExamPolicy(value);
  return (
    normalized === "liderazgo y trabajo en equipo" ||
    normalized === "liderazgo y trabajo en equipo presencial"
  );
}

export function isExamOptionalForCourse(params: {
  program?: string | null;
  courseName?: string | null;
}): boolean {
  return isExamOptionalProgram(params.program) || isExamOptionalCourseName(params.courseName);
}
