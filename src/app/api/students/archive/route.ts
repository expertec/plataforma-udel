import { NextRequest, NextResponse } from "next/server";
import {
  archiveStudentAccount,
  StudentArchiveError,
} from "@/lib/server/student-archive";
import {
  requireAdminTeacherAccess,
  toAdminTeacherRouteErrorResponse,
} from "@/lib/server/require-admin-teacher-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ArchiveStudentRequest = {
  studentId?: string;
  email?: string;
  reason?: string;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: NextRequest) {
  try {
    const adminContext = await requireAdminTeacherAccess(request);
    const body = (await request.json().catch(() => ({}))) as ArchiveStudentRequest;
    const studentId = asTrimmedString(body.studentId);
    const email = asTrimmedString(body.email).toLowerCase();

    if (!studentId && !email) {
      return NextResponse.json(
        { success: false, error: "studentId o email son requeridos" },
        { status: 400 },
      );
    }

    const result = await archiveStudentAccount({
      uid: studentId || undefined,
      email: email || undefined,
      archivedBy: adminContext.uid,
      source: "admin-panel",
      reason: body.reason,
    });

    return NextResponse.json(
      {
        success: true,
        data: result,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    if (error instanceof StudentArchiveError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return toAdminTeacherRouteErrorResponse(error, "Error archivando alumno");
  }
}
