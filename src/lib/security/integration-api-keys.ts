import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getAdminFirestore } from "@/lib/firebase/admin";

export const INTEGRATION_API_KEYS_COLLECTION = "integrationApiKeys";
export const INTEGRATION_API_KEY_PREFIX = "udlx_live";
export const DEFAULT_API_KEY_TTL_DAYS = 90;
export const PLATFORM_SCOPE = "platform.*";
export const FINANCE_WEBHOOK_SCOPE = "finance.webhook.student-registration";

type KeyStatus = "active" | "revoked";
type RouteStatus = KeyStatus | "expired";

type ApiKeyDoc = {
  name: string;
  scope: string;
  prefix: string;
  secretHash: string;
  salt: string;
  status: KeyStatus;
  createdAt: Date;
  createdBy: string;
  expiresAt: Date;
  revokedAt?: Date;
  revokedBy?: string;
  revokeReason?: string;
  lastUsedAt?: Date;
};

export type ApiKeyListItem = {
  id: string;
  name: string;
  scope: string;
  prefix: string;
  status: RouteStatus;
  createdAt: string | null;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  lastUsedAt: string | null;
};

export type CreatedApiKey = {
  id: string;
  name: string;
  scope: string;
  prefix: string;
  expiresAt: string | null;
  createdAt: string;
  apiKey: string;
};

type ParsedRawKey = {
  publicId: string;
  secret: string;
};

type VerifyResult = {
  valid: boolean;
  reason?: "format" | "not-found" | "revoked" | "expired" | "hash" | "scope";
  keyId?: string;
  scope?: string;
  prefix?: string;
};

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
}

function toIso(value: unknown): string | null {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function resolvePepper(): string {
  const pepper = asText(process.env.API_KEY_HASH_PEPPER);
  if (!pepper) {
    throw new Error("API_KEY_HASH_PEPPER no está configurado");
  }
  return pepper;
}

function resolveDefaultTtlDays(): number | null {
  const raw = asText(process.env.API_KEY_DEFAULT_TTL_DAYS);
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_API_KEY_TTL_DAYS;
  if (!Number.isFinite(parsed)) return DEFAULT_API_KEY_TTL_DAYS;
  if (parsed <= 0) return null;
  return Math.min(parsed, 365);
}

function resolveTtlDays(requested?: number): number | null {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return resolveDefaultTtlDays();
  }
  const rounded = Math.floor(requested);
  if (rounded <= 0) return null;
  if (rounded > 365) return 365;
  return rounded;
}

function parseApiKey(rawApiKey: string): ParsedRawKey | null {
  const pattern = new RegExp(`^${INTEGRATION_API_KEY_PREFIX}_([a-f0-9]{12})_([A-Za-z0-9_-]{20,})$`);
  const match = rawApiKey.trim().match(pattern);
  if (!match) return null;
  const [, publicId, secret] = match;
  return { publicId, secret };
}

function buildKeyHash(secret: string, salt: string, pepper: string): string {
  return scryptSync(secret, `${salt}:${pepper}`, 64).toString("hex");
}

function safeHashMatch(expectedHash: string, candidateHash: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const candidate = Buffer.from(candidateHash, "hex");
  if (expected.length !== candidate.length) return false;
  return timingSafeEqual(expected, candidate);
}

function scopeAllows(grantedScope: string, requestedScope: string): boolean {
  const granted = grantedScope.trim().toLowerCase();
  const requested = requestedScope.trim().toLowerCase();
  if (!granted || !requested) return false;
  if (granted === PLATFORM_SCOPE) return true;
  if (granted === requested) return true;
  if (granted.endsWith(".*")) {
    const grantedPrefix = granted.slice(0, -1);
    return requested.startsWith(grantedPrefix);
  }
  return false;
}

function mapRouteStatus(status: KeyStatus, expiresAt: unknown): RouteStatus {
  if (status === "revoked") return "revoked";
  const expiresAtDate = toDate(expiresAt);
  if (expiresAtDate && expiresAtDate.getTime() <= Date.now()) return "expired";
  return "active";
}

function normalizeScope(scope: string): string {
  return scope.trim().toLowerCase();
}

function buildPrefix(publicId: string): string {
  return `${INTEGRATION_API_KEY_PREFIX}_${publicId}`;
}

function generatePublicId(): string {
  return randomBytes(6).toString("hex");
}

function generateSecretToken(): string {
  return randomBytes(24).toString("base64url");
}

function getCollection() {
  return getAdminFirestore().collection(INTEGRATION_API_KEYS_COLLECTION);
}

export async function listIntegrationApiKeys(): Promise<ApiKeyListItem[]> {
  const snap = await getCollection().orderBy("createdAt", "desc").get();
  return snap.docs.map((docSnap) => {
    const data = docSnap.data();
    const statusFromDoc = asText(data.status) === "revoked" ? "revoked" : "active";
    return {
      id: docSnap.id,
      name: asText(data.name) ?? "Sin nombre",
      scope: asText(data.scope) ?? PLATFORM_SCOPE,
      prefix: asText(data.prefix) ?? buildPrefix(docSnap.id),
      status: mapRouteStatus(statusFromDoc, data.expiresAt),
      createdAt: toIso(data.createdAt),
      createdBy: asText(data.createdBy) ?? "desconocido",
      expiresAt: toIso(data.expiresAt),
      revokedAt: toIso(data.revokedAt),
      revokedBy: asText(data.revokedBy),
      revokeReason: asText(data.revokeReason),
      lastUsedAt: toIso(data.lastUsedAt),
    };
  });
}

export async function createIntegrationApiKey(params: {
  name: string;
  scope?: string;
  expiresInDays?: number;
  createdBy: string;
}): Promise<CreatedApiKey> {
  const pepper = resolvePepper();
  const ttlDays = resolveTtlDays(params.expiresInDays);
  const name = params.name.trim();
  const scope = normalizeScope(params.scope?.trim() || PLATFORM_SCOPE);
  const createdAt = new Date();
  const expiresAt = ttlDays ? new Date(createdAt.getTime() + ttlDays * 24 * 60 * 60 * 1000) : null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const publicId = generatePublicId();
    const docRef = getCollection().doc(publicId);
    const existing = await docRef.get();
    if (existing.exists) continue;

    const salt = randomBytes(16).toString("hex");
    const secret = generateSecretToken();
    const secretHash = buildKeyHash(secret, salt, pepper);
    const prefix = buildPrefix(publicId);
    const fullKey = `${prefix}_${secret}`;

    const payload: ApiKeyDoc = {
      name,
      scope,
      prefix,
      salt,
      secretHash,
      status: "active",
      createdAt,
      createdBy: params.createdBy,
    };
    if (expiresAt) {
      payload.expiresAt = expiresAt;
    }

    await docRef.set(payload);

    return {
      id: publicId,
      name,
      scope,
      prefix,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      createdAt: createdAt.toISOString(),
      apiKey: fullKey,
    };
  }

  throw new Error("No se pudo generar una llave única");
}

export async function revokeIntegrationApiKey(params: {
  keyId: string;
  revokedBy: string;
  reason?: string;
}): Promise<{ success: boolean; revokedAt: string }> {
  const ref = getCollection().doc(params.keyId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error("API_KEY_NOT_FOUND");
  }

  const revokedAt = new Date();
  await ref.set(
    {
      status: "revoked",
      revokedAt,
      revokedBy: params.revokedBy,
      revokeReason: params.reason?.trim() || null,
      updatedAt: revokedAt,
    },
    { merge: true },
  );

  return {
    success: true,
    revokedAt: revokedAt.toISOString(),
  };
}

export async function verifyIntegrationApiKey(params: {
  apiKey: string;
  requiredScope: string;
  updateLastUsed?: boolean;
}): Promise<VerifyResult> {
  const parsed = parseApiKey(params.apiKey);
  if (!parsed) {
    return { valid: false, reason: "format" };
  }

  const ref = getCollection().doc(parsed.publicId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { valid: false, reason: "not-found" };
  }

  const data = snap.data();
  const salt = asText(data?.salt);
  const secretHash = asText(data?.secretHash);
  const status = asText(data?.status) === "revoked" ? "revoked" : "active";
  const scope = asText(data?.scope) ?? PLATFORM_SCOPE;
  const prefix = asText(data?.prefix) ?? buildPrefix(parsed.publicId);
  const expiresAt = toDate(data?.expiresAt);

  if (!salt || !secretHash) {
    return { valid: false, reason: "not-found" };
  }

  if (status === "revoked") {
    return { valid: false, reason: "revoked" };
  }

  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return { valid: false, reason: "expired" };
  }

  const pepper = resolvePepper();
  const incomingHash = buildKeyHash(parsed.secret, salt, pepper);
  if (!safeHashMatch(secretHash, incomingHash)) {
    return { valid: false, reason: "hash" };
  }

  if (!scopeAllows(scope, params.requiredScope)) {
    return { valid: false, reason: "scope" };
  }

  if (params.updateLastUsed !== false) {
    void ref.set({ lastUsedAt: new Date() }, { merge: true });
  }

  return {
    valid: true,
    keyId: snap.id,
    scope,
    prefix,
  };
}
