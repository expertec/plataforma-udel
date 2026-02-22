import { NextRequest, NextResponse } from "next/server";
import {
  PLATFORM_SCOPE,
  createIntegrationApiKey,
  listIntegrationApiKeys,
} from "@/lib/security/integration-api-keys";
import {
  requireAdminTeacher,
  toRouteErrorResponse,
} from "@/lib/server/require-super-admin-teacher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CreateApiKeyRequest = {
  name?: string;
  scope?: string;
  expiresInDays?: number;
};

function normalizeScope(scope?: string): string {
  const normalized = scope?.trim().toLowerCase();
  if (!normalized) return PLATFORM_SCOPE;
  return normalized;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdminTeacher(request);
    const keys = await listIntegrationApiKeys();
    return NextResponse.json({ success: true, data: keys }, { status: 200 });
  } catch (error: unknown) {
    return toRouteErrorResponse(error, "Error listando API keys");
  }
}

export async function POST(request: NextRequest) {
  try {
    const adminContext = await requireAdminTeacher(request);
    const body = (await request.json()) as CreateApiKeyRequest;
    const name = body?.name?.trim();
    if (!name) {
      return NextResponse.json(
        { success: false, error: "name es requerido" },
        { status: 400 },
      );
    }

    if (name.length > 80) {
      return NextResponse.json(
        { success: false, error: "name no puede exceder 80 caracteres" },
        { status: 400 },
      );
    }

    const expiresInDays =
      typeof body?.expiresInDays === "number" && Number.isFinite(body.expiresInDays)
        ? body.expiresInDays
        : undefined;

    const created = await createIntegrationApiKey({
      name,
      scope: normalizeScope(body?.scope),
      expiresInDays,
      createdBy: adminContext.uid,
    });

    return NextResponse.json(
      {
        success: true,
        data: created,
      },
      { status: 201 },
    );
  } catch (error: unknown) {
    return toRouteErrorResponse(error, "Error creando API key");
  }
}
