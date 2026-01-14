import { NextRequest, NextResponse } from "next/server";
import { unlinkCourseFromGroup } from "@/lib/firebase/groups-service";

type UnlinkCourseRequest = {
  groupId: string;
  courseId: string;
};

export async function POST(request: NextRequest) {
  try {
    const body: UnlinkCourseRequest = await request.json();
    const { groupId, courseId } = body;

    if (!groupId || !courseId) {
      return NextResponse.json(
        { error: "groupId y courseId son requeridos" },
        { status: 400 }
      );
    }

    await unlinkCourseFromGroup({ groupId, courseId });

    return NextResponse.json({
      success: true,
      message: "Curso desvinculado del grupo correctamente",
    });
  } catch (error: any) {
    console.error("Error al desvincular curso del grupo:", error);
    return NextResponse.json(
      { error: error.message || "Error al desvincular curso del grupo" },
      { status: 500 }
    );
  }
}
