export type GradeScaleFinding = {
  courseId: string;
  courseName: string;
  grade: number;
  suggestedGrade: number;
  autoGrade: number | null;
  gradedAt: string | null;
  closedAt: string | null;
  priority: "high" | "review";
  reasons: string[];
};

export type GradeScaleAnalysisRow = GradeScaleFinding & {
  revision: string;
  enrollmentId: string;
  source: "studentEnrollments" | "studentEnrollmentsArchive";
  studentId: string;
  studentName: string;
  groupId: string;
  groupName: string;
};

export type GradeCorrection = {
  id: string;
  source: GradeScaleAnalysisRow["source"];
  enrollmentId: string;
  studentId: string;
  studentName: string;
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  previousGrade: number;
  newGrade: number;
  reason: string;
  actorId: string;
  actorName: string;
  actorEmail: string | null;
  actorRole: string;
  correctedAt: string | null;
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function gradeAnalysisIsoDate(value: unknown): string | null {
  try {
    if (value === null || value === undefined || value === "") return null;
    const timestamp = object(value);
    const date = typeof timestamp.toDate === "function" ? timestamp.toDate() as Date
      : value instanceof Date ? value
      : typeof value === "string" || typeof value === "number" ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

export function enrollmentGradeClosures(data: Record<string, unknown>): Record<string, unknown> {
  const closures = { ...object(data.courseClosures) };
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("courseClosures.") && key.length > "courseClosures.".length) {
      const courseId = key.slice("courseClosures.".length);
      if (!(courseId in closures)) closures[courseId] = value;
    }
  }
  return closures;
}

/** Findings are candidates for human review, never automatic conversions. */
export function analyzeEnrollmentGradeScale(data: Record<string, unknown>): GradeScaleFinding[] {
  const closures = enrollmentGradeClosures(data);
  const findings: GradeScaleFinding[] = [];
  for (const [courseId, raw] of Object.entries(closures)) {
    const closure = object(raw);
    const grade = closure.finalGrade;
    if (closure.status !== "closed" || typeof grade !== "number" || !Number.isFinite(grade) ||
      grade <= 0 || grade > 10 || closure.gradeScale === 100) continue;
    // Imported academic history and equivalencies already normalize their source scale.
    if (closure.academicHistoryId || closure.equivalencyId) continue;
    const suggestedGrade = Math.round(grade * 100) / 10;
    const autoGrade = typeof closure.autoGrade === "number" && Number.isFinite(closure.autoGrade)
      ? closure.autoGrade : null;
    const reasons = ["La nota final está entre 0 y 10 y no consta como escala de 100."];
    let priority: GradeScaleFinding["priority"] = "review";
    if (closure.gradeScale === 10) {
      reasons.push("El registro indica explícitamente una escala de 10.");
      priority = "high";
    }
    if (autoGrade !== null && autoGrade >= 70 && autoGrade <= 100 && Math.abs(autoGrade - suggestedGrade) <= 1) {
      reasons.push(`Al convertir a ${suggestedGrade}/100 coincide con el cálculo automático de ${autoGrade}/100.`);
      priority = "high";
    } else if (autoGrade !== null && autoGrade >= 70 && autoGrade <= 100) {
      reasons.push(`El cálculo automático es aprobatorio (${autoGrade}/100), pero la nota final es ${grade}/100.`);
    }
    if (closure.manualOverride === true) reasons.push("La nota final se capturó manualmente.");
    reasons.push("Puede ser una nota baja real; verifica el acta antes de convertirla.");
    findings.push({ courseId, courseName: typeof closure.courseName === "string" ? closure.courseName : "",
      grade, suggestedGrade, autoGrade, gradedAt: gradeAnalysisIsoDate(closure.gradedAt),
      closedAt: gradeAnalysisIsoDate(closure.closedAt), priority, reasons });
  }
  return findings;
}
