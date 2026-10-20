import { auth } from "./client";
import type { AcademicHistoryInput, StudentAcademicHistory } from "@/lib/students/academic-history";

async function requestAcademicHistory(studentId: string, method: string, body?: unknown, history = false): Promise<StudentAcademicHistory[]> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Necesitas iniciar sesión para consultar el historial académico.");
  const response = await fetch(`/api/students/${encodeURIComponent(studentId)}/academic-history${history ? "?history=1" : ""}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true) throw new Error(payload.error || "No se pudo consultar el historial académico.");
  return payload.data.records;
}

export const getStudentAcademicHistory = (studentId: string, history = false) =>
  requestAcademicHistory(studentId, "GET", undefined, history);

export const createStudentAcademicHistory = (studentId: string, entries: AcademicHistoryInput[]) =>
  requestAcademicHistory(studentId, "POST", { entries });

export const updateStudentAcademicHistory = (studentId: string, id: string, version: number, entry: AcademicHistoryInput, reason: string) =>
  requestAcademicHistory(studentId, "PATCH", { action: "update", id, version, entry, reason });

export const cancelStudentAcademicHistory = (studentId: string, id: string, version: number, reason: string) =>
  requestAcademicHistory(studentId, "PATCH", { action: "cancel", id, version, reason });
