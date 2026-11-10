import { getExtraordinaryExamValidityLabel, isExtraordinaryExamExpired } from "@/lib/global-exams/types";
import { normalizeProgramLevelText } from "@/lib/program-level";
import { isCertificationGroup } from "./kardex";

// Temporarily hide student notices while historical final grades are reviewed.
// Re-enable both student interfaces here once that review is complete.
export const STUDENT_ACADEMIC_ALERTS_ENABLED = false;

type AlertAssignment = {
  courseId: string;
  courseName?: string;
  groupId?: string;
  groupName?: string;
  reason: string;
  passed: boolean;
  enabled: boolean;
  status: string;
  examKind?: "global" | "extraordinary";
  expiresAt?: string | null;
  attemptsUsed: number;
  attemptsAllowed: number;
};

export type AcademicAlertEvidence = {
  groupId?: string;
  groupName?: string;
  program?: string;
  isCertification?: boolean;
  pendingUngradedCount?: number;
  totalEvaluable?: number;
  manualOverride?: boolean;
  campusFinalExamGrade?: number | null;
  gradeSource?: string;
};

type AlertClosure = AcademicAlertEvidence & { status?: string; finalGrade?: number; courseName?: string };

function courseNameFrom(courseId: string, ...values: unknown[]): string | undefined {
  return values.filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .find((value) => value && value !== courseId &&
      !/^(?:materia|curso)(?:\s*\([^)]*\))?$/.test(normalizeProgramLevelText(value)));
}

// Historical closures can refer to courses no longer present in "Mis clases".
// Resolve their catalog metadata without loading lessons or changing grades.
export async function hydrateAcademicAlertCourses(
  closures: Record<string, AlertClosure>,
  titles: Record<string, string>,
  readCourse: (courseId: string) => Promise<Record<string, unknown> | null>,
): Promise<void> {
  const missing = new Map<string, AlertClosure[]>();
  Object.entries(closures).forEach(([key, closure]) => {
    const courseId = key.split("::")[1];
    if (!courseId || closure.status !== "closed" || typeof closure.finalGrade !== "number" ||
      !Number.isFinite(closure.finalGrade) || closure.finalGrade < 0 || closure.finalGrade >= 70 ||
      courseNameFrom(courseId, titles[courseId])) return;
    const entries = missing.get(courseId) ?? [];
    entries.push(closure);
    missing.set(courseId, entries);
  });
  await Promise.all(Array.from(missing, async ([courseId, entries]) => {
    try {
      const course = await readCourse(courseId);
      if (!course) return;
      const title = courseNameFrom(courseId, course.title);
      if (title) titles[courseId] = title;
      const certification = isAcademicAlertCertification({
        program: typeof course.program === "string" ? course.program :
          typeof course.category === "string" ? course.category : "",
        isCertification: course.isCertification === true,
      }, title);
      entries.forEach((closure) => {
        if (!courseNameFrom(courseId, closure.courseName) && title) closure.courseName = title;
        closure.isCertification = closure.isCertification || certification;
      });
    } catch {
      // A missing/unreadable catalog entry must not prevent loading the aula.
      // The notice uses a human-readable fallback and keeps the original grade.
    }
  }));
}

// Keep the evidence when adapting Firestore closures for either student interface.
export function academicAlertEvidence(
  closure: Record<string, unknown>,
  enrollment: Record<string, unknown>,
  group: Record<string, unknown> = {},
): AcademicAlertEvidence {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  return {
    groupId: text(enrollment.groupId),
    groupName: text(group.groupName) || text(enrollment.groupName),
    program: text(group.program) || text(enrollment.program) || text(closure.program),
    isCertification: closure.isCertification === true || enrollment.isCertification === true || group.isCertification === true,
    pendingUngradedCount: typeof closure.pendingUngradedCount === "number" ? closure.pendingUngradedCount : undefined,
    totalEvaluable: typeof closure.totalEvaluable === "number" ? closure.totalEvaluable : undefined,
    manualOverride: closure.manualOverride === true,
    campusFinalExamGrade: typeof closure.campusFinalExamGrade === "number" ? closure.campusFinalExamGrade : null,
    gradeSource: text(closure.gradeSource),
  };
}

export function isAcademicAlertCertification(closure: AcademicAlertEvidence & { courseName?: string }, title?: string): boolean {
  return closure.isCertification === true || isCertificationGroup(closure.groupName) ||
    /\bcertificacion(?:es)?\b/.test(normalizeProgramLevelText(closure.program || "")) ||
    /^certificacion(?:es)?\b/.test(normalizeProgramLevelText(closure.courseName || "")) ||
    /^certificacion(?:es)?\b/.test(normalizeProgramLevelText(title || ""));
}

function hasDefinitiveGrade(closure: AlertClosure): boolean {
  // Missing/ungraded activities must not become a confirmed failure solely
  // because a legacy closure contains a partial sum (often zero).
  return closure.manualOverride === true ||
    (typeof closure.campusFinalExamGrade === "number" && Number.isFinite(closure.campusFinalExamGrade)) ||
    (closure.pendingUngradedCount === 0 && closure.totalEvaluable !== 0) ||
    closure.gradeSource === "globalRegularizationExam" || closure.gradeSource === "extraordinaryRegularizationExam";
}

export function getAcademicAlert(
  closures: Record<string, AlertClosure>,
  titles: Record<string, string>,
  assignments: AlertAssignment[],
  nowMs: number,
) {
  const approved = new Set(assignments.filter((exam) => exam.passed || exam.status === "passed").map((exam) => exam.courseId));
  Object.entries(closures).forEach(([key, closure]) => {
    if (closure.status === "closed" && typeof closure.finalGrade === "number" &&
      Number.isFinite(closure.finalGrade) && closure.finalGrade >= 70 && closure.finalGrade <= 100) {
      approved.add(key.split("::")[1]);
    }
  });
  const pending = new Map<string, string>();
  const recovery = new Set<string>();
  const failedClosures = Object.entries(closures).filter(([key, closure]) => {
    const courseId = key.split("::")[1];
    return courseId && !approved.has(courseId) && !isAcademicAlertCertification(closure, titles[courseId]) &&
      closure.status === "closed" && hasDefinitiveGrade(closure) &&
      typeof closure.finalGrade === "number" && Number.isFinite(closure.finalGrade) &&
      closure.finalGrade >= 0 && closure.finalGrade < 70;
  });
  failedClosures.forEach(([key, closure]) => {
    const courseId = key.split("::")[1];
    if (closure.finalGrade! > 49) return;
    pending.set(courseId, courseNameFrom(courseId, closure.courseName, titles[courseId], pending.get(courseId)) || "Materia pendiente de identificar");
    recovery.add(courseId);
  });
  const exams = assignments.filter((exam) => exam.reason === "failed_course" && exam.status !== "disabled" &&
    !isCertificationGroup(exam.groupName) && failedClosures.some(([key, closure]) =>
      key.split("::")[1] === exam.courseId && (!exam.groupId || closure.groupId === exam.groupId)));
  exams.forEach((exam) => {
    pending.set(exam.courseId, courseNameFrom(exam.courseId, exam.courseName, titles[exam.courseId], pending.get(exam.courseId)) || "Materia pendiente de identificar");
  });
  const count = pending.size;
  const summary = count > 0
    ? `Tienes ${count} ${count === 1 ? "materia no acreditada" : "materias no acreditadas"}: ${Array.from(pending.values()).join(", ")}.`
    : "";
  const validity = exams.filter((exam) => pending.has(exam.courseId) && exam.examKind === "extraordinary" &&
    exam.enabled && exam.status === "enabled" && exam.expiresAt)
    .map((exam) => `${pending.get(exam.courseId)}: ${getExtraordinaryExamValidityLabel(exam.expiresAt!, nowMs)}`)
    .join(" · ");
  return {
    notice: [summary, recovery.size > 0 ? "Acércate a tu coordinador." : "", validity].filter(Boolean).join(" "),
    hasActiveExam: exams.some((exam) => pending.has(exam.courseId) && exam.enabled && exam.status === "enabled" &&
      !exam.passed && exam.attemptsUsed < exam.attemptsAllowed && !isExtraordinaryExamExpired(exam, nowMs)),
  };
}
