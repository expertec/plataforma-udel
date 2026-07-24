import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StudentPlatformView = "modern" | "traditional";

type PlatformViewRequest = {
  preferredView?: unknown;
};

const STUDENT_PLATFORM_VIEW_FIELD = "preferredStudentView";

class RouteAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function asStudentPlatformView(value: unknown): StudentPlatformView {
  if (value !== "modern" && value !== "traditional") {
    throw new RouteAccessError(400, "preferredView debe ser modern o traditional");
  }
  return value;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveRole(value: unknown): string {
  return asTrimmedString(value);
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }

  console.error("Error actualizando vista preferida del alumno", error);
  const message =
    process.env.NODE_ENV !== "production" && error instanceof Error
      ? error.message.trim() || "Error interno del servidor"
      : "Error interno del servidor";
  return NextResponse.json({ success: false, error: message }, { status: 500 });
}

export async function POST(request: NextRequest) {
  try {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!token) {
      throw new RouteAccessError(401, "Authorization Bearer token requerido");
    }

    let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
    try {
      decodedToken = await getAdminAuth().verifyIdToken(token);
    } catch {
      throw new RouteAccessError(401, "Token inválido o expirado");
    }

    const body = (await request.json().catch(() => ({}))) as PlatformViewRequest;
    const preferredView = asStudentPlatformView(body.preferredView);
    const userRef = getAdminFirestore().collection("users").doc(decodedToken.uid);
    const userSnap = await userRef.get();
    const userData = (userSnap.data() ?? {}) as Record<string, unknown>;
    const role = resolveRole(userData.role) || resolveRole(decodedToken.role);

    if (role && role !== "student") {
      throw new RouteAccessError(403, "Esta preferencia solo está disponible para alumnos");
    }

    await userRef.set(
      {
        [STUDENT_PLATFORM_VIEW_FIELD]: preferredView,
        updatedAt: new Date(),
      },
      { merge: true },
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          preferredView,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
