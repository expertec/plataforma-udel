import { NextRequest, NextResponse } from "next/server";
import {
  FINANCE_WEBHOOK_ARCHIVE_SCOPE,
  FINANCE_WEBHOOK_SCOPE,
} from "@/lib/security/integration-api-keys";
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
  const registrationEndpoint = `${baseUrl}/api/finance/webhook/student-registration`;
  const deactivationEndpoint = `${baseUrl}/api/finance/webhook/student-deactivation`;
  const defaultPassword = process.env.FINANCE_WEBHOOK_DEFAULT_PASSWORD?.trim() || "ascensoUDEL";
  const supportContact = process.env.API_DOCS_DEFAULT_CONTACT?.trim() || "Equipo Plataforma UDEL";

  return `# Guía de Integración API - Plataforma Educativa UDEL

## 1) Endpoint de alta de alumnos (Webhook/API entrante)

- URL: \`${registrationEndpoint}\`
- Método: \`POST\`
- Content-Type: \`application/json\`
- Scope recomendado de API key: \`${FINANCE_WEBHOOK_SCOPE}\`

El endpoint de alta se mantiene compatible con el payload actual. Si el alumno ya existe pero estaba archivado, la plataforma lo reactiva y conserva el flujo normal de alta.

## 2) Endpoint de baja de alumnos (Archivado)

- URL: \`${deactivationEndpoint}\`
- Método: \`POST\`
- Content-Type: \`application/json\`
- Scope recomendado de API key: \`${FINANCE_WEBHOOK_ARCHIVE_SCOPE}\`

La baja **no elimina** al alumno. La plataforma lo archiva:

- se conserva su historial
- deja de aparecer en listados operativos
- deja de contar en grupos y estadísticas
- se bloquea su acceso a la plataforma

## 3) Autenticación

Puedes enviar la llave en cualquiera de estos headers:

- \`Authorization: Bearer <API_KEY>\`
- \`x-webhook-secret: <API_KEY>\`
- \`x-api-key: <API_KEY>\`

Formato de llave emitida por panel:

\`udlx_live_<publicId>_<secret>\`

## 4) Payload mínimo recomendado para alta

\`\`\`json
{
  "event": "student.created",
  "student": {
    "email": "alumno@dominio.com",
    "name": "Nombre Alumno",
    "phone": "6671234567",
    "program": "Lic. Administración",
    "groupId": "GRUPO_ABC123"
  }
}
\`\`\`

Nota: si no envías \`password\`, la plataforma usará la contraseña por defecto configurada (\`${defaultPassword}\`).

## 5) Payload extendido para alta (opcional)

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
    "programId": "program_doc_id_001",
    "groupId": "GRUPO_ABC123",
    "groupName": "Grupo Matutino A",
    "studentId": "POS-1138"
  },
  "updatePasswordIfExists": false
}
\`\`\`

Puedes enviar el grupo como \`groupName\`. Por compatibilidad también puede venir en \`groupId\` o \`groupIds\` (usa el primero), pero en todos los casos la plataforma lo interpreta como nombre/clave y busca en \`groups.groupName\`.
Si \`groupName\` coincide con más de un grupo, la plataforma intenta desambiguar con \`program/programId\`; si persiste la ambigüedad, responde \`409\`.

Si se resuelve un grupo por \`groupName\`, la plataforma además:

- Inscribe al alumno en \`groups/{groupId}/students/{studentId}\`
- Crea/actualiza \`studentEnrollments/{groupId}_{studentId}\`
- Incrementa \`groups.studentsCount\` solo si no estaba inscrito previamente

Programa de estudio:

- \`program\`: nombre directo del programa.
- \`programId\`: ID del documento en \`programs\` (tiene prioridad sobre \`program\`).

## 6) Payload recomendado para baja

\`\`\`json
{
  "event": "student.deactivated",
  "student": {
    "email": "alumno@dominio.com"
  }
}
\`\`\`

También puedes enviar un identificador explícito:

\`\`\`json
{
  "event": "alumno.baja",
  "eventId": "pv-2026-baja-0007",
  "student": {
    "studentId": "uid_o_id_externo",
    "email": "alumno@dominio.com"
  },
  "reason": "Baja administrativa"
}
\`\`\`

La baja acepta \`studentId\`, \`alumnoId\`, \`uid\`, \`userId\` o \`email/correo\`.

## 7) Respuestas esperadas

- \`200\`: alumno creado o sincronizado correctamente.
- \`200\`: alumno archivado correctamente.
- \`202\`: evento ignorado (no corresponde a alumno).
- \`400\`: payload inválido o campos requeridos faltantes.
- \`401\`: autenticación inválida.
- \`409\`: el correo existe con rol distinto a estudiante.
- \`500\`: error interno del servidor.

## 8) Recomendaciones operativas

- Crear una API key por integración/sistema.
- Definir expiración y rotar llaves de forma periódica.
- Revocar inmediatamente llaves comprometidas.
- Registrar \`eventId\` para trazabilidad e idempotencia del lado integrador.

## 9) Soporte

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
