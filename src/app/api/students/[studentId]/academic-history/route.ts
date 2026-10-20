import { NextRequest, NextResponse } from "next/server";
import {
  EquivalencyError,
  canManageEquivalencies,
  resolveEquivalencyAccess,
} from "@/lib/server/student-equivalencies";

import { mutateStudentAcademicHistory, parseAcademicHistoryMutation, readStudentAcademicHistory } from "@/lib/server/student-academic-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ studentId: string }> };

async function handle(request: NextRequest, context: RouteContext) {
  try {
    const { studentId } = await context.params;
    const access = await resolveEquivalencyAccess(request.headers.get("authorization"));
    if (request.method !== "GET") {
      if (!canManageEquivalencies(access)) throw new EquivalencyError(403, "Solo los administradores pueden modificar el historial académico.");
      const body = await request.json().catch(() => { throw new EquivalencyError(400, "Solicitud inválida."); });
      await mutateStudentAcademicHistory(studentId, access, parseAcademicHistoryMutation(body, request.method === "POST"));
    }
    const history = canManageEquivalencies(access) && (request.method !== "GET" || request.nextUrl.searchParams.get("history") === "1");
    const records = await readStudentAcademicHistory(studentId, access, history);
    return NextResponse.json({ success: true, data: { records } });
  } catch (error) {
    if (error instanceof EquivalencyError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error("Error procesando historial académico:", error);
    return NextResponse.json({ success: false, error: "No se pudo procesar el historial académico." }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
