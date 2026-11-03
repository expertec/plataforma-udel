import { getExtraordinaryExamValidityLabel, isExtraordinaryExamExpired } from "@/lib/global-exams/types";

type AlertAssignment = {
  courseId: string;
  courseName?: string;
  reason: string;
  passed: boolean;
  enabled: boolean;
  status: string;
  examKind?: "global" | "extraordinary";
  expiresAt?: string | null;
  attemptsUsed: number;
  attemptsAllowed: number;
};

type AlertClosure = { status?: string; finalGrade?: number; courseName?: string };

export function getAcademicAlert(
  closures: Record<string, AlertClosure>,
  titles: Record<string, string>,
  assignments: AlertAssignment[],
  nowMs: number,
) {
  const approved = new Set(assignments.filter((exam) => exam.passed || exam.status === "passed").map((exam) => exam.courseId));
  Object.entries(closures).forEach(([key, closure]) => {
    if (closure.status === "closed" && typeof closure.finalGrade === "number" && closure.finalGrade >= 70) {
      approved.add(key.split("::")[1]);
    }
  });
  const pending = new Map<string, string>();
  const recovery = new Set<string>();
  Object.entries(closures).forEach(([key, closure]) => {
    const courseId = key.split("::")[1];
    if (!courseId || approved.has(courseId) || closure.status !== "closed" ||
      typeof closure.finalGrade !== "number" || !Number.isFinite(closure.finalGrade) || closure.finalGrade > 49) return;
    pending.set(courseId, closure.courseName?.trim() || titles[courseId]?.trim() || `Materia (${courseId})`);
    recovery.add(courseId);
  });
  const exams = assignments.filter((exam) => exam.courseId && !approved.has(exam.courseId));
  exams.forEach((exam) => {
    if (exam.reason !== "failed_course" || exam.status === "disabled") return;
    pending.set(exam.courseId, exam.courseName?.trim() || titles[exam.courseId]?.trim() || pending.get(exam.courseId) || `Materia (${exam.courseId})`);
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
