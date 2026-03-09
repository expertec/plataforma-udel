import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export type EncryptedSecretPayload = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  cipherText: string;
};

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_VERSION = 1 as const;

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveSecretMaterial(): string | null {
  return (
    asText(process.env.KANWAP_CONFIG_SECRET) ??
    asText(process.env.API_KEY_HASH_PEPPER)
  );
}

function resolveSecretKey(): Buffer {
  const secretMaterial = resolveSecretMaterial();
  if (!secretMaterial) {
    throw new Error(
      "No hay secreto de cifrado configurado. Define KANWAP_CONFIG_SECRET o API_KEY_HASH_PEPPER.",
    );
  }
  return createHash("sha256").update(secretMaterial, "utf8").digest();
}

export function isSecretEncryptionConfigured(): boolean {
  return Boolean(resolveSecretMaterial());
}

export function encryptSecretText(value: string): EncryptedSecretPayload {
  const plainText = value.trim();
  if (!plainText) {
    throw new Error("No se puede cifrar un secreto vacío");
  }

  const key = resolveSecretKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plainText, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    version: ENCRYPTION_VERSION,
    algorithm: ENCRYPTION_ALGORITHM,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    cipherText: encrypted.toString("base64"),
  };
}

export function decryptSecretText(payload: EncryptedSecretPayload): string {
  if (
    payload.version !== ENCRYPTION_VERSION ||
    payload.algorithm !== ENCRYPTION_ALGORITHM
  ) {
    throw new Error("Formato de secreto cifrado no soportado");
  }

  const key = resolveSecretKey();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const cipherText = Buffer.from(payload.cipherText, "base64");

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(cipherText),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function maskSecret(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";
  if (normalized.length <= 8) {
    return `${"*".repeat(Math.max(0, normalized.length - 2))}${normalized.slice(-2)}`;
  }
  const prefix = normalized.slice(0, 6);
  const suffix = normalized.slice(-4);
  return `${prefix}${"*".repeat(Math.max(0, normalized.length - 10))}${suffix}`;
}
