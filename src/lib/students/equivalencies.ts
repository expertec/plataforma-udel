export type EquivalencyInput = {
  courseId: string | null;
  courseName: string;
  grade: number;
  gradeScale: 10 | 100;
  institution: string;
  period: string;
  recognizedAt: string;
  notes: string;
};

export type StudentEquivalency = EquivalencyInput & {
  id: string;
  studentId: string;
  finalGrade: number;
  status: "active" | "cancelled";
  plantelIds: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  version: number;
  changeReason: string;
};

export function equivalencyNameKey(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function validateEquivalencyInput(value: unknown): EquivalencyInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("La equivalencia no es válida.");
  }
  const input = value as Record<string, unknown>;
  const readText = (key: string, maximum: number, required = false): string => {
    if (input[key] !== undefined && input[key] !== null && typeof input[key] !== "string") {
      throw new Error(`El campo ${key} no es válido.`);
    }
    const text = typeof input[key] === "string" ? input[key].trim() : "";
    if ((required && !text) || text.length > maximum) {
      throw new Error(`Revisa el campo ${key} (máximo ${maximum} caracteres).`);
    }
    return text;
  };
  const courseId = readText("courseId", 200) || null;
  if (courseId && (courseId.includes("/") || courseId === "." || courseId === "..")) {
    throw new Error("La materia seleccionada no es válida.");
  }
  const courseName = readText("courseName", 200, true);
  const gradeScale = input.gradeScale;
  if (gradeScale !== 10 && gradeScale !== 100) throw new Error("Selecciona una escala de 10 o 100.");
  const grade = input.grade;
  if (typeof grade !== "number" || !Number.isFinite(grade) || grade < gradeScale * 0.7 || grade > gradeScale) {
    throw new Error(`La equivalencia debe tener una calificación aprobatoria entre ${gradeScale * 0.7} y ${gradeScale}.`);
  }
  const recognizedAt = readText("recognizedAt", 10, true);
  const parsedDate = new Date(`${recognizedAt}T12:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recognizedAt) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== recognizedAt) {
    throw new Error("La fecha de reconocimiento no es válida.");
  }
  return {
    courseId, courseName, grade, gradeScale, recognizedAt,
    institution: readText("institution", 200),
    period: readText("period", 100),
    notes: readText("notes", 2000),
  };
}

export const equivalencyFinalGrade = (input: Pick<EquivalencyInput, "grade" | "gradeScale">): number =>
  Math.round((input.grade / input.gradeScale) * 1000) / 10;

export function equivalencyGradeRow(equivalency: StudentEquivalency) {
  return {
    id: `equivalency::${equivalency.id}`,
    equivalencyId: equivalency.id,
    countsTowardProgram: Boolean(equivalency.courseId),
    groupId: "",
    groupName: equivalency.institution || "Equivalencia",
    courseId: equivalency.courseId || "",
    courseName: equivalency.courseName,
    status: "closed" as const,
    finalGrade: equivalency.finalGrade,
    autoGrade: null,
    globalExamGrade: null,
    globalExamSource: null,
    extraordinaryExamGrade: null,
    extraordinaryExamSource: null,
    pendingUngradedCount: null,
    closedAt: `${equivalency.recognizedAt}T12:00:00.000Z`,
    updatedAt: equivalency.updatedAt,
  };
}
