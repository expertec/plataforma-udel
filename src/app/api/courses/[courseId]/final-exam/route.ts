import { NextRequest, NextResponse } from "next/server";
import { FinalExamError, finalExamId, finalExamUser, readFinalExam, saveFinalExam, submitFinalExam } from "@/lib/server/final-exams";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ courseId: string }> };

async function handle(request: NextRequest, context: Context) {
  try {
    const courseId = finalExamId((await context.params).courseId);
    const user = await finalExamUser(request.headers.get("authorization"));
    if (request.method === "GET") {
      const input = Object.fromEntries(request.nextUrl.searchParams);
      return NextResponse.json({ success: true, data: await readFinalExam(courseId, input, user) });
    }
    const body = await request.json().catch(() => { throw new FinalExamError(400, "Solicitud inválida."); });
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new FinalExamError(400, "Solicitud inválida.");
    const data = request.method === "POST" ? await saveFinalExam(courseId, body, user) : await submitFinalExam(courseId, body, user);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (error instanceof FinalExamError) return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    console.error("Error procesando examen final:", error);
    return NextResponse.json({ success: false, error: "No se pudo procesar el examen final." }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
