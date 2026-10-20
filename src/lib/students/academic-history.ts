import { equivalencyNameKey } from "./equivalencies";
import type { KardexSection } from "./kardex";

export type AccreditationType = "ordinary" | "extraordinary" | "global";
export const accreditationLabels: Record<AccreditationType, string> = {
  ordinary: "Ordinario", extraordinary: "Extraordinario", global: "Global",
};

export type AcademicHistoryInput = {
  courseId: string | null;
  courseName: string;
  groupId: string | null;
  groupName: string;
  cycle: string;
  semester: string;
  section: KardexSection;
  accreditationType: AccreditationType;
  grade: number;
  gradeScale: 10 | 100;
  registeredAt: string;
  notes: string;
};

export type StudentAcademicHistory = AcademicHistoryInput & {
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

export type ManualKardexFields = {
  academicHistoryId?: string;
  cycle?: string;
  section?: KardexSection;
  accreditationType?: AccreditationType;
  registeredAt?: string;
};

export function validateAcademicHistoryInput(value: unknown): AcademicHistoryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("El registro académico no es válido.");
  const input = value as Record<string, unknown>;
  const readText = (key: string, maximum: number, required = false): string => {
    if (input[key] != null && typeof input[key] !== "string") throw new Error(`El campo ${key} no es válido.`);
    const result = typeof input[key] === "string" ? input[key].trim() : "";
    if ((required && !result) || result.length > maximum) throw new Error(`Revisa el campo ${key} (máximo ${maximum} caracteres).`);
    return result;
  };
  const readId = (key: string) => {
    const id = readText(key, 200) || null;
    if (id && (id.includes("/") || id === "." || id === "..")) throw new Error(`El identificador ${key} no es válido.`);
    return id;
  };
  const gradeScale = input.gradeScale;
  if (gradeScale !== 10 && gradeScale !== 100) throw new Error("Selecciona una escala de 10 o 100.");
  const grade = input.grade;
  if (typeof grade !== "number" || !Number.isFinite(grade) || grade < 0 || grade > gradeScale) throw new Error(`La calificación debe estar entre 0 y ${gradeScale}.`);
  const registeredAt = readText("registeredAt", 10, true);
  const date = new Date(`${registeredAt}T12:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(registeredAt) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== registeredAt) throw new Error("La fecha de registro no es válida.");
  if (input.section !== "academic" && input.section !== "certifications") throw new Error("Selecciona licenciatura o certificaciones.");
  const accreditationType = input.accreditationType;
  if (accreditationType !== "ordinary" && accreditationType !== "extraordinary" && accreditationType !== "global") throw new Error("Selecciona un tipo de acreditación válido.");
  const semester = readText("semester", 2, true);
  if (!/^[1-9]\d?$/.test(semester)) throw new Error("El cuatrimestre debe ser un número entre 1 y 99.");
  return {
    courseId: readId("courseId"), courseName: readText("courseName", 200, true),
    groupId: readId("groupId"), groupName: readText("groupName", 200, true),
    cycle: readText("cycle", 100, true), semester, section: input.section,
    accreditationType, grade, gradeScale, registeredAt, notes: readText("notes", 2000),
  };
}

export const academicHistoryFinalGrade = (input: Pick<AcademicHistoryInput, "grade" | "gradeScale">) =>
  Math.round(input.grade / input.gradeScale * 1000) / 10;

export function sameAcademicSubject(left: { courseId?: string | null; courseName: string }, right: { courseId?: string | null; courseName: string }): boolean {
  return Boolean(left.courseId && left.courseId === right.courseId) || equivalencyNameKey(left.courseName) === equivalencyNameKey(right.courseName);
}

export function sameAcademicAttempt(left: AcademicHistoryInput, right: AcademicHistoryInput): boolean {
  const sameGroup = Boolean(left.groupId && left.groupId === right.groupId) || equivalencyNameKey(left.groupName) === equivalencyNameKey(right.groupName);
  return left.section === right.section && sameGroup && equivalencyNameKey(left.cycle) === equivalencyNameKey(right.cycle) && sameAcademicSubject(left, right);
}

/** Date-only formatting avoids timezone shifts and never uses the audit timestamp. */
export function formatManualRegistrationDate(value: string | undefined): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "—";
  const [year, month, day] = value.split("-");
  return `M-${day}/${month}/${year}`;
}

export function academicHistoryGradeRow(entry: StudentAcademicHistory) {
  return {
    id: `academic-history::${entry.id}`, academicHistoryId: entry.id,
    countsTowardProgram: Boolean(entry.courseId) && entry.section === "academic",
    groupId: entry.groupId || "", groupName: entry.groupName,
    courseId: entry.courseId || "", courseName: entry.courseName,
    semester: entry.semester, cycle: entry.cycle, section: entry.section,
    isCertification: entry.section === "certifications",
    accreditationType: entry.accreditationType, registeredAt: entry.registeredAt,
    status: "closed" as const, finalGrade: entry.finalGrade, autoGrade: null,
    globalExamGrade: entry.accreditationType === "global" ? entry.finalGrade : null,
    globalExamSource: null,
    extraordinaryExamGrade: entry.accreditationType === "extraordinary" ? entry.finalGrade : null,
    extraordinaryExamSource: null, pendingUngradedCount: null,
    closedAt: `${entry.registeredAt}T12:00:00.000Z`, updatedAt: entry.updatedAt,
  };
}
