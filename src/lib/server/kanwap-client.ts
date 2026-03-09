type KanwapEnvelope<T> = {
  exito?: boolean;
  mensaje?: string;
  errores?: unknown;
  datos?: T;
};

export type KanwapSessionState =
  | "conectada"
  | "desconectada"
  | "pendiente"
  | "conectando"
  | string;

export type KanwapSession = {
  id: string;
  nombre: string;
  telefono: string;
  estado: KanwapSessionState;
};

export type KanwapSessionStatus = {
  estado: KanwapSessionState;
  id?: string;
  nombre?: string;
  telefono?: string;
};

export type KanwapSendTextResult = {
  tipo?: string;
  mensajeId?: string;
  destino?: string;
  enviado?: boolean;
};

type KanwapRequestParams = {
  apiKey: string;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function resolveKanwapBaseUrl(): string {
  return normalizeBaseUrl(
    process.env.KANWAP_API_URL?.trim() || "https://kanwap.udelonline.com",
  );
}

function normalizeErrors(rawErrors: unknown): string[] {
  if (!Array.isArray(rawErrors)) return [];
  return rawErrors
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

async function safeParseJson<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export class KanwapApiError extends Error {
  status: number;
  errors: string[];
  retryable: boolean;

  constructor(
    message: string,
    params?: { status?: number; errors?: string[]; retryable?: boolean },
  ) {
    super(message);
    this.name = "KanwapApiError";
    this.status = params?.status ?? 500;
    this.errors = params?.errors ?? [];
    this.retryable = params?.retryable ?? false;
  }
}

async function kanwapRequest<T>(params: KanwapRequestParams): Promise<T> {
  const apiKey = asText(params.apiKey);
  if (!apiKey) {
    throw new KanwapApiError("API key de KanWap requerida", { status: 400 });
  }

  const baseUrl = resolveKanwapBaseUrl();
  const timeoutMs = Number.isFinite(params.timeoutMs) ? Number(params.timeoutMs) : 30000;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${params.path}`, {
      method: params.method ?? "GET",
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
      cache: "no-store",
      signal: controller.signal,
    });

    const envelope = await safeParseJson<KanwapEnvelope<T>>(response);
    const mensaje = asText(envelope?.mensaje) || "Error en KanWap";
    const errors = normalizeErrors(envelope?.errores);
    const isSuccess = envelope?.exito === true && envelope?.datos !== undefined;

    if (!response.ok || !isSuccess) {
      throw new KanwapApiError(mensaje, {
        status: response.status || 502,
        errors,
        retryable:
          response.status === 429 ||
          response.status >= 500 ||
          response.status === 0,
      });
    }

    return envelope.datos as T;
  } catch (error: unknown) {
    if (error instanceof KanwapApiError) throw error;
    const isAbortError = (error as { name?: string })?.name === "AbortError";
    throw new KanwapApiError(
      isAbortError
        ? "Tiempo de espera agotado al consultar KanWap"
        : "No se pudo conectar con KanWap",
      {
        status: isAbortError ? 504 : 502,
        retryable: true,
      },
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function normalizeSession(raw: unknown): KanwapSession | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const id = asText(source.id);
  if (!id) return null;
  return {
    id,
    nombre: asText(source.nombre) || "Sin nombre",
    telefono: asText(source.telefono),
    estado: asText(source.estado) || "desconocida",
  };
}

export async function listKanwapSessions(
  apiKey: string,
  params?: { estado?: string },
): Promise<KanwapSession[]> {
  const estado = asText(params?.estado);
  const suffix = estado ? `?estado=${encodeURIComponent(estado)}` : "";
  const data = await kanwapRequest<{ sesiones?: unknown[] }>({
    apiKey,
    path: `/api/v1/sesiones${suffix}`,
    method: "GET",
  });

  const sessions = Array.isArray(data.sesiones) ? data.sesiones : [];
  return sessions
    .map((entry) => normalizeSession(entry))
    .filter((entry): entry is KanwapSession => Boolean(entry));
}

export async function getKanwapSessionStatus(
  apiKey: string,
  sessionId: string,
): Promise<KanwapSessionStatus> {
  const normalizedSessionId = asText(sessionId);
  if (!normalizedSessionId) {
    throw new KanwapApiError("sessionId es requerido", { status: 400 });
  }

  const data = await kanwapRequest<{ estado?: unknown; id?: unknown; nombre?: unknown; telefono?: unknown }>({
    apiKey,
    path: `/api/v1/sesion/${encodeURIComponent(normalizedSessionId)}/estado`,
    method: "GET",
  });

  return {
    estado: asText(data.estado) || "desconocida",
    id: asText(data.id) || undefined,
    nombre: asText(data.nombre) || undefined,
    telefono: asText(data.telefono) || undefined,
  };
}

export async function sendKanwapTextMessage(params: {
  apiKey: string;
  sessionId: string;
  destination: string;
  message: string;
}): Promise<KanwapSendTextResult> {
  const sessionId = asText(params.sessionId);
  const destination = asText(params.destination).replace(/\s+/g, "");
  const message = params.message?.trim() || "";
  if (!sessionId) {
    throw new KanwapApiError("sessionId es requerido", { status: 400 });
  }
  if (!destination) {
    throw new KanwapApiError("destino es requerido", { status: 400 });
  }
  if (!message) {
    throw new KanwapApiError("mensaje es requerido", { status: 400 });
  }

  const data = await kanwapRequest<{
    tipo?: unknown;
    mensajeId?: unknown;
    destino?: unknown;
    enviado?: unknown;
  }>({
    apiKey: params.apiKey,
    path: "/api/v1/enviar/texto",
    method: "POST",
    body: {
      sesionId: sessionId,
      destino: destination,
      mensaje: message,
    },
  });

  return {
    tipo: asText(data.tipo) || undefined,
    mensajeId: asText(data.mensajeId) || undefined,
    destino: asText(data.destino) || destination,
    enviado: data.enviado === true,
  };
}

export function getKanwapBaseUrlForDisplay(): string {
  return resolveKanwapBaseUrl();
}
