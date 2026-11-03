"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { getExtraordinaryExamValidityLabel, isExtraordinaryExamExpired } from "@/lib/global-exams/types";
import { useAulaData } from "../_lib/AulaDataContext";

export function AcademicAlert() {
  const { courseClosures, courseTitles, examAssignments } = useAulaData();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const recoveryCourses = new Map<string, string>();
  Object.entries(courseClosures).forEach(([key, closure]) => {
    if (closure.status !== "closed" || typeof closure.finalGrade !== "number" || closure.finalGrade > 49) return;
    const courseId = key.split("::")[1];
    recoveryCourses.set(courseId, closure.courseName || courseTitles[courseId] || "sin nombre");
  });
  const recoveryNames = Array.from(recoveryCourses.values());
  const recoveryNotice = recoveryNames.length > 0
    ? `Tienes ${recoveryNames.length} ${recoveryNames.length === 1 ? "materia no acreditada" : "materias no acreditadas"}. Acércate a tu coordinador.`
    : "";
  const passedKeys = new Set(examAssignments
    .filter((assignment) => assignment.passed || assignment.status === "passed")
    .map((assignment) => `${assignment.groupId}::${assignment.courseId}`));
  const failedKeys = new Set(examAssignments
    .filter((assignment) => assignment.reason === "failed_course" && assignment.status !== "disabled" &&
      assignment.courseId && !passedKeys.has(`${assignment.groupId}::${assignment.courseId}`))
    .map((assignment) => `${assignment.groupId}::${assignment.courseId}`));
  const extraordinaryNotice = examAssignments
    .filter((assignment) => assignment.examKind === "extraordinary" && assignment.enabled &&
      assignment.status === "enabled" && assignment.expiresAt &&
      !passedKeys.has(`${assignment.groupId}::${assignment.courseId}`))
    .map((assignment) => `${assignment.courseName || "Extraordinario"}: ${getExtraordinaryExamValidityLabel(assignment.expiresAt!, nowMs)}`)
    .join(" · ");
  const notice = [recoveryNotice, extraordinaryNotice].filter(Boolean).join(" · ") ||
    (failedKeys.size === 1 ? "Tienes 1 materia no acreditada" : failedKeys.size > 1 ? `Tienes ${failedKeys.size} materias no acreditadas` : "");
  const hasActiveExam = examAssignments.some((assignment) => assignment.enabled &&
    assignment.status === "enabled" && !assignment.passed &&
    assignment.attemptsUsed < assignment.attemptsAllowed && !isExtraordinaryExamExpired(assignment, nowMs));

  if (!notice) return null;

  return (
    <div role="status" className="border-b border-yellow-600 bg-yellow-400 text-black shadow-lg">
      <div className="mx-auto flex h-12 max-w-6xl items-center justify-center gap-3 px-4">
        <TriangleAlert aria-hidden="true" className="h-5 w-5 shrink-0" />
        <p title={notice} className="m-0 min-w-0 overflow-x-auto whitespace-nowrap text-sm font-semibold">{notice}</p>
        {hasActiveExam ? (
          <Link href="/aula/examenes-globales" className="shrink-0 rounded-md bg-black px-3 py-1.5 text-sm font-bold text-yellow-300 transition hover:bg-neutral-800">
            Ver exámenes
          </Link>
        ) : null}
      </div>
    </div>
  );
}
