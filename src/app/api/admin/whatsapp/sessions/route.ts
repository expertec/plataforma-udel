import { NextRequest, NextResponse } from "next/server";
import {
  requireAdminTeacher,
  toRouteErrorResponse,
} from "@/lib/server/require-super-admin-teacher";
import {
  KanwapApiError,
  listKanwapSessions,
} from "@/lib/server/kanwap-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ListSessionsRequest = {
  apiKey?: string;
  estado?: string;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function kanwapErrorResponse(error: KanwapApiError) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
      errors: error.errors,
      retryable: error.retryable,
    },
    { status: error.status || 502 },
  );
}

export async function POST(request: NextRequest) {
  try {
    await requireAdminTeacher(request);
    const body = (await request.json()) as ListSessionsRequest;
    const apiKey = asText(body.apiKey);
    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "apiKey es requerido" },
        { status: 400 },
      );
    }
    const sessions = await listKanwapSessions(apiKey, {
      estado: asText(body.estado) || undefined,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          total: sessions.length,
          sessions,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    if (error instanceof KanwapApiError) {
      return kanwapErrorResponse(error);
    }
    return toRouteErrorResponse(error, "Error listando sesiones de KanWap");
  }
}
