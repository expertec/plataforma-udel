import { NextRequest, NextResponse } from "next/server";
import { revokeIntegrationApiKey } from "@/lib/security/integration-api-keys";
import {
  requireAdminTeacher,
  toRouteErrorResponse,
} from "@/lib/server/require-super-admin-teacher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RevokeApiKeyRequest = {
  reason?: string;
};

type RevokeRouteContext = {
  params: Promise<{ keyId: string }> | { keyId: string };
};

async function resolveContextParams(context: RevokeRouteContext): Promise<{ keyId: string }> {
  const resolved = await context.params;
  return {
    keyId: resolved.keyId,
  };
}

export async function POST(request: NextRequest, context: RevokeRouteContext) {
  try {
    const adminContext = await requireAdminTeacher(request);
    const { keyId } = await resolveContextParams(context);
    if (!keyId?.trim()) {
      return NextResponse.json(
        { success: false, error: "keyId es requerido" },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as RevokeApiKeyRequest;
    const result = await revokeIntegrationApiKey({
      keyId: keyId.trim(),
      revokedBy: adminContext.uid,
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
    if ((error as { message?: string }).message === "API_KEY_NOT_FOUND") {
      return NextResponse.json(
        { success: false, error: "API key no encontrada" },
        { status: 404 },
      );
    }
    return toRouteErrorResponse(error, "Error revocando API key");
  }
}
