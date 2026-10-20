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
  // Next.js/proxy failures can return plain text or HTML before the route runs.
  // Preserve the HTTP failure instead of exposing a JSON parsing exception.
  const payload = await response.json().catch(() => null) as {
    success?: boolean;
    error?: unknown;
    data?: { records?: StudentAcademicHistory[] };
  } | null;
  if (!response.ok || payload?.success !== true) {
    const message = typeof payload?.error === "string" && payload.error.trim()
      ? payload.error
      : `No se pudo consultar el historial académico${response.ok ? "" : ` (HTTP ${response.status})`}. Reintenta en unos momentos.`;
    throw new Error(message);
  }
  if (!Array.isArray(payload.data?.records)) {
    throw new Error("La respuesta del historial académico no es válida. Recarga la página e intenta nuevamente.");
  }
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
