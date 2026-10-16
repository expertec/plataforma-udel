import { auth } from "./client";

export async function finalExamRequest<Response>(courseId: string, method: "GET" | "POST" | "PUT", data: Record<string, unknown>): Promise<Response> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Inicia sesión para continuar.");
  const query = method === "GET" ? `?${new URLSearchParams(Object.entries(data).map(([key, value]) => [key, String(value)]))}` : "";
  const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/final-exam${query}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(data), cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || payload.success !== true) throw new Error(payload.error || "No se pudo procesar el examen final.");
  return payload.data;
}
