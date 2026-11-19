import { NextRequest, NextResponse } from "next/server";
import { FieldPath } from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { requireGradeScaleAccess } from "@/lib/server/grade-scale-access";
import { requireTeacherAccess, TeacherAccessError, toTeacherAccessErrorResponse } from "@/lib/server/require-teacher-access";
import { correctGradeScale, parseGradeCorrection, serializeGradeCorrection } from "@/lib/server/grade-scale-corrections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PAGE_SIZE = 100;

export async function POST(request: NextRequest) {
  try {
    const actor = await requireTeacherAccess(request);
    let body: unknown;
    try { body = await request.json(); } catch { throw new TeacherAccessError(400, "Solicitud inválida."); }
    const correction = await correctGradeScale(actor, parseGradeCorrection(body), {
      userAgent: (request.headers.get("user-agent") || "").slice(0, 512),
      forwardedFor: (request.headers.get("x-forwarded-for") || "").slice(0, 256),
      requestTrace: (request.headers.get("x-vercel-id") || request.headers.get("x-request-id") || "").slice(0, 256),
    });
    return NextResponse.json({ success: true, data: correction }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return toTeacherAccessErrorResponse(error, "Error corrigiendo escala de calificación");
  }
}

export async function GET(request: NextRequest) {
  try {
    const { allowedGroupIds } = await requireGradeScaleAccess(request);
    const after = request.nextUrl.searchParams.get("after") || "";
    const groupOffset = Number(request.nextUrl.searchParams.get("groupOffset") || "0");
    if (after.includes("/") || !Number.isSafeInteger(groupOffset) || groupOffset < 0) throw new TeacherAccessError(400, "Página inválida.");
    if (allowedGroupIds !== null && groupOffset >= allowedGroupIds.length) {
      return NextResponse.json({ success: true, data: { rows: [], nextCursor: null, nextGroupOffset: null } }, { headers: { "Cache-Control": "no-store" } });
    }
    let query = getAdminFirestore().collection("gradeScaleCorrections").orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (allowedGroupIds !== null) query = query.where("groupId", "==", allowedGroupIds[groupOffset]);
    if (after) query = query.startAfter(after);
    const snapshot = await query.get();
    return NextResponse.json({ success: true, data: {
      rows: snapshot.docs.map(doc => serializeGradeCorrection(doc.id, doc.data())),
      nextCursor: snapshot.size === PAGE_SIZE ? snapshot.docs.at(-1)!.id : null,
      nextGroupOffset: allowedGroupIds !== null && (snapshot.size === PAGE_SIZE || groupOffset + 1 < allowedGroupIds.length)
        ? snapshot.size === PAGE_SIZE ? groupOffset : groupOffset + 1 : null,
    } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return toTeacherAccessErrorResponse(error, "Error leyendo historial de correcciones");
  }
}
