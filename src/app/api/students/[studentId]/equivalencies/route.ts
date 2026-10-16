import { NextRequest, NextResponse } from "next/server";
import {
  EquivalencyError,
  canManageEquivalencies,
  mutateStudentEquivalencies,
  parseEquivalencyMutation,
  readStudentEquivalencies,
  resolveEquivalencyAccess,
} from "@/lib/server/student-equivalencies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ studentId: string }> };

async function handle(request: NextRequest, context: RouteContext) {
  try {
    const { studentId } = await context.params;
    const access = await resolveEquivalencyAccess(request.headers.get("authorization"));
    if (request.method !== "GET") {
      if (!canManageEquivalencies(access)) throw new EquivalencyError(403, "Solo los administradores pueden modificar equivalencias.");
      const body = await request.json().catch(() => { throw new EquivalencyError(400, "Solicitud inválida."); });
      await mutateStudentEquivalencies(studentId, access, parseEquivalencyMutation(body, request.method === "POST"));
    }
    const history = canManageEquivalencies(access) && (request.method !== "GET" || request.nextUrl.searchParams.get("history") === "1");
    const equivalencies = await readStudentEquivalencies(studentId, access, history);
    return NextResponse.json({ success: true, data: { equivalencies } });
  } catch (error) {
    if (error instanceof EquivalencyError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error("Error procesando equivalencias:", error);
    return NextResponse.json({ success: false, error: "No se pudieron procesar las equivalencias." }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
