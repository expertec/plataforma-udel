import { NextRequest, NextResponse } from "next/server";
import { FINANCE_WEBHOOK_SCOPE } from "@/lib/security/integration-api-keys";
import {
  requireAdminTeacher,
  toRouteErrorResponse,
} from "@/lib/server/require-super-admin-teacher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PUBLIC_URL_FALLBACK = "https://api.tu-dominio.com";

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function resolvePublicBaseUrl(request: NextRequest): string {
  const configured =
    process.env.WEBHOOK_PUBLIC_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "";
  if (configured) {
    return normalizeBaseUrl(configured);
  }

  const requestOrigin = normalizeBaseUrl(request.nextUrl.origin);
  if (requestOrigin.includes("localhost") || requestOrigin.includes("127.0.0.1")) {
    const vercelUrl = process.env.VERCEL_URL?.trim();
    if (vercelUrl) {
      return normalizeBaseUrl(`https://${vercelUrl}`);
    }
    return PUBLIC_URL_FALLBACK;
  }
  return requestOrigin;
}

function buildGuideMarkdown(baseUrl: string): string {
  const endpoint = `${baseUrl}/api/finance/webhook/student-registration`;
  const defaultPassword = process.env.FINANCE_WEBHOOK_DEFAULT_PASSWORD?.trim() || "ascensoUDEL";
  const supportContact = process.env.API_DOCS_DEFAULT_CONTACT?.trim() || "Equipo Plataforma UDEL";

  return `# Guía de Integración API - Plataforma Educativa UDEL

## 1) Endpoint de alta de alumnos (Webhook/API entrante)

- URL: \`${endpoint}\`
- Método: \`POST\`
- Content-Type: \`application/json\`
- Scope recomendado de API key: \`${FINANCE_WEBHOOK_SCOPE}\`

## 2) Autenticación

Puedes enviar la llave en cualquiera de estos headers:

- \`Authorization: Bearer <API_KEY>\`
- \`x-webhook-secret: <API_KEY>\`
- \`x-api-key: <API_KEY>\`

Formato de llave emitida por panel:

\`udlx_live_<publicId>_<secret>\`

## 3) Payload mínimo recomendado

\`\`\`json
{
  "event": "student.created",
  "student": {
    "email": "alumno@dominio.com",
    "name": "Nombre Alumno",
    "phone": "6671234567",
    "program": "Lic. Administración"
  }
}
\`\`\`

Nota: si no envías \`password\`, la plataforma usará la contraseña por defecto configurada (\`${defaultPassword}\`).

## 4) Payload extendido (opcional)

\`\`\`json
{
  "event": "student.created",
  "eventId": "pv-2026-0001",
  "student": {
    "email": "alumno@dominio.com",
    "password": "Temporal123!",
    "name": "Nombre Alumno",
    "phone": "6671234567",
    "program": "Lic. Administración",
    "studentId": "POS-1138"
  },
  "updatePasswordIfExists": false
}
\`\`\`

## 5) Respuestas esperadas

- \`200\`: alumno creado o sincronizado correctamente.
- \`202\`: evento ignorado (no corresponde a alumno).
- \`400\`: payload inválido o campos requeridos faltantes.
- \`401\`: autenticación inválida.
- \`409\`: el correo existe con rol distinto a estudiante.
- \`500\`: error interno del servidor.

## 6) Recomendaciones operativas

- Crear una API key por integración/sistema.
- Definir expiración y rotar llaves de forma periódica.
- Revocar inmediatamente llaves comprometidas.
- Registrar \`eventId\` para trazabilidad e idempotencia del lado integrador.

## 7) Soporte

- Contacto técnico: ${supportContact}
`;
}

function markdownToText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

export async function GET(request: NextRequest) {
  try {
    await requireAdminTeacher(request);
    const format = request.nextUrl.searchParams.get("format")?.toLowerCase() === "txt" ? "txt" : "md";
    const shouldDownload = request.nextUrl.searchParams.get("download") === "1";
    const markdownGuide = buildGuideMarkdown(resolvePublicBaseUrl(request));
    const body = format === "txt" ? markdownToText(markdownGuide) : markdownGuide;
    const fileName = `udelx-api-guide.${format}`;

    const headers = new Headers();
    headers.set("Cache-Control", "no-store");
    headers.set(
      "Content-Type",
      format === "txt" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8",
    );
    if (shouldDownload) {
      headers.set("Content-Disposition", `attachment; filename="${fileName}"`);
    }

    return new NextResponse(body, { status: 200, headers });
  } catch (error: unknown) {
    return toRouteErrorResponse(error, "Error generando guía API");
  }
}
