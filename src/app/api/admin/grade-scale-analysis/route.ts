import { NextRequest, NextResponse } from "next/server";
import { FieldPath } from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { toTeacherAccessErrorResponse } from "@/lib/server/require-teacher-access";
import { requireGradeScaleAccess } from "@/lib/server/grade-scale-access";
import { analyzeEnrollmentGradeScale, type GradeScaleAnalysisRow } from "@/lib/students/grade-scale-analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PAGE_SIZE = 200;
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export async function GET(request: NextRequest) {
  try {
    const { allowedGroupIds } = await requireGradeScaleAccess(request);
    const db = getAdminFirestore();
    const source = request.nextUrl.searchParams.get("source") || "studentEnrollments";
    const after = request.nextUrl.searchParams.get("after") || "";
    const groupOffset = Number(request.nextUrl.searchParams.get("groupOffset") || "0");
    if (!["studentEnrollments", "studentEnrollmentsArchive"].includes(source) || after.includes("/") ||
      !Number.isSafeInteger(groupOffset) || groupOffset < 0) {
      return NextResponse.json({ success: false, error: "Parámetros de análisis inválidos." }, { status: 400 });
    }
    if (allowedGroupIds !== null && groupOffset >= allowedGroupIds.length) {
      return NextResponse.json({ success: true, data: { rows: [], scanned: 0, nextCursor: null, nextGroupOffset: null } },
        { headers: { "Cache-Control": "no-store" } });
    }
    let query = db.collection(source).orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (allowedGroupIds !== null) query = query.where("groupId", "==", allowedGroupIds[groupOffset]);
    if (after) query = query.startAfter(after);
    const snapshot = await query.get();
    const rows: GradeScaleAnalysisRow[] = snapshot.docs.flatMap(doc => {
      const data = doc.data();
      return analyzeEnrollmentGradeScale(data).map(finding => ({
        ...finding, enrollmentId: doc.id, source: source as GradeScaleAnalysisRow["source"],
        revision: doc.updateTime ? `${doc.updateTime.seconds}:${doc.updateTime.nanoseconds}` : "",
        studentId: text(data.studentId), studentName: text(data.studentName),
        groupId: text(data.groupId), groupName: text(data.groupName),
      }));
    });
    const references = new Map<string, ReturnType<typeof db.doc>>();
    for (const row of rows) {
      for (const [collection, id] of [["groups", row.groupId], ["courses", row.courseId], ["users", row.studentId]]) {
        if (id && !id.includes("/")) references.set(`${collection}/${id}`, db.collection(collection).doc(id));
      }
    }
    const metadata = new Map<string, Record<string, unknown>>();
    const refs = [...references.values()];
    for (let offset = 0; offset < refs.length; offset += 100) {
      const docs = await db.getAll(...refs.slice(offset, offset + 100));
      docs.forEach(doc => metadata.set(doc.ref.path, doc.data() || {}));
    }
    for (const row of rows) {
      const student = metadata.get(`users/${row.studentId}`);
      row.studentName ||= text(student?.displayName) || text(student?.name) || row.studentId || "Sin nombre";
      row.groupName ||= text(metadata.get(`groups/${row.groupId}`)?.groupName) || row.groupId || "Sin grupo";
      row.courseName ||= text(metadata.get(`courses/${row.courseId}`)?.title) || row.courseId;
    }
    return NextResponse.json({ success: true, data: {
      rows, scanned: snapshot.size, nextCursor: snapshot.size === PAGE_SIZE ? snapshot.docs.at(-1)!.id : null,
      nextGroupOffset: allowedGroupIds !== null && (snapshot.size === PAGE_SIZE || groupOffset + 1 < allowedGroupIds.length)
        ? snapshot.size === PAGE_SIZE ? groupOffset : groupOffset + 1 : null,
    } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return toTeacherAccessErrorResponse(error, "Error analizando escalas de calificaciones");
  }
}
