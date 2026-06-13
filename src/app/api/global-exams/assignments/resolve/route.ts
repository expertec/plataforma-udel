import { NextRequest, NextResponse } from "next/server";
import { getAdminFirestore } from "@/lib/firebase/admin";
import { toGlobalExamTemplateRecord, resolveStudentCourseEnrollments } from "@/lib/server/global-exams";
import {
  getCoordinatorScopeGroupIds,
  requireGlobalExamAccess,
  toGlobalExamRouteErrorResponse,
} from "@/lib/server/global-exams-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const access = await requireGlobalExamAccess(request, [
      "coordinadorPlantel",
      "director",
      "adminTeacher",
      "superAdminTeacher",
    ]);
    const url = new URL(request.url);
    const studentId = url.searchParams.get("studentId")?.trim() ?? "";
    const templateId = url.searchParams.get("templateId")?.trim() ?? "";

    if (!studentId || !templateId) {
      return NextResponse.json(
        { success: false, error: "studentId y templateId son requeridos" },
        { status: 400 },
      );
    }

    const templateSnap = await getAdminFirestore().collection("globalExamTemplates").doc(templateId).get();
    if (!templateSnap.exists) {
      return NextResponse.json(
        { success: false, error: "No se encontro la plantilla solicitada" },
        { status: 404 },
      );
    }

    const template = toGlobalExamTemplateRecord(templateSnap.id, templateSnap.data() ?? {});
    const allowedGroupIds =
      access.role === "coordinadorPlantel" || access.role === "director"
        ? new Set(await getCoordinatorScopeGroupIds(access.uid, access.plantelIds))
        : undefined;
    const enrollments = await resolveStudentCourseEnrollments(
      studentId,
      template.courseId,
      allowedGroupIds,
      template.courseName,
    );

    return NextResponse.json({
      success: true,
      data: enrollments,
    });
  } catch (error) {
    return toGlobalExamRouteErrorResponse(error, "Error resolviendo inscripciones para examen global");
  }
}
