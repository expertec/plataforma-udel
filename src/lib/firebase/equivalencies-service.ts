import { auth } from "./client";
import type { EquivalencyInput, StudentEquivalency } from "@/lib/students/equivalencies";

async function requestEquivalencies(studentId: string, method: string, body?: unknown, history = false): Promise<StudentEquivalency[]> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Necesitas iniciar sesión para consultar equivalencias.");
  const response = await fetch(`/api/students/${encodeURIComponent(studentId)}/equivalencies${history ? "?history=1" : ""}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true) throw new Error(payload.error || "No se pudieron consultar las equivalencias.");
  return payload.data.equivalencies;
}

export const getStudentEquivalencies = (studentId: string, history = false) =>
  requestEquivalencies(studentId, "GET", undefined, history);

export const createStudentEquivalencies = (studentId: string, entries: EquivalencyInput[]) =>
  requestEquivalencies(studentId, "POST", { entries });

export const updateStudentEquivalency = (studentId: string, id: string, version: number, entry: EquivalencyInput, reason: string) =>
  requestEquivalencies(studentId, "PATCH", { action: "update", id, version, entry, reason });

export const cancelStudentEquivalency = (studentId: string, id: string, version: number, reason: string) =>
  requestEquivalencies(studentId, "PATCH", { action: "cancel", id, version, reason });
