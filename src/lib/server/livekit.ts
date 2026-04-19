import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodingOptionsPreset,
  GCPUpload,
  RoomServiceClient,
  WebhookReceiver,
} from "livekit-server-sdk";
import type { EgressInfo } from "livekit-server-sdk";

type LiveKitConfig = {
  serverUrl: string;
  clientUrl: string;
  apiKey: string;
  apiSecret: string;
  webhookKey: string;
  webhookSecret: string;
};

type LiveKitEgressConfig = {
  egressBucket: string;
  egressPrefix: string;
  egressCredentials: string;
};

let cachedConfig: LiveKitConfig | null = null;
let cachedEgressConfig: LiveKitEgressConfig | null = null;
let cachedRoomServiceClient: RoomServiceClient | null = null;
let cachedEgressClient: EgressClient | null = null;
let cachedWebhookReceiver: WebhookReceiver | null = null;

function requiredEnv(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function normalizeLiveKitUrls(rawValue: string): { serverUrl: string; clientUrl: string } {
  const raw = rawValue.trim();
  if (!raw) {
    throw new Error("Missing required env var: LIVEKIT_URL");
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("LIVEKIT_URL inválido");
  }

  const protocol = parsed.protocol.toLowerCase();
  if (!["http:", "https:", "ws:", "wss:"].includes(protocol)) {
    throw new Error("LIVEKIT_URL inválido");
  }

  const server = new URL(parsed.toString());
  server.protocol = protocol === "ws:" ? "http:" : protocol === "wss:" ? "https:" : protocol;
  const client = new URL(parsed.toString());
  client.protocol = protocol === "http:" ? "ws:" : protocol === "https:" ? "wss:" : protocol;

  return {
    serverUrl: server.toString().replace(/\/$/, ""),
    clientUrl: client.toString().replace(/\/$/, ""),
  };
}

function resolveEgressCredentials(): string {
  const explicit = (process.env.LIVEKIT_EGRESS_GCS_CREDENTIALS_JSON ?? "").trim();
  if (explicit) return explicit;

  const serviceAccountJson = (process.env.FIREBASE_SERVICE_ACCOUNT_KEY ?? "").trim();
  if (serviceAccountJson) return serviceAccountJson;

  const projectId = (process.env.FIREBASE_ADMIN_PROJECT_ID ?? "").trim();
  const privateKey = (process.env.FIREBASE_ADMIN_PRIVATE_KEY ?? "").trim();
  const clientEmail = (process.env.FIREBASE_ADMIN_CLIENT_EMAIL ?? "").trim();
  if (projectId && privateKey && clientEmail) {
    return JSON.stringify({
      type: "service_account",
      project_id: projectId,
      private_key: privateKey.replace(/\\n/g, "\n"),
      client_email: clientEmail,
    });
  }

  throw new Error(
    "Missing GCS credentials for LiveKit egress. Define LIVEKIT_EGRESS_GCS_CREDENTIALS_JSON or Firebase Admin service account env vars.",
  );
}

export function getLiveKitConfig(): LiveKitConfig {
  if (cachedConfig) return cachedConfig;
  const urls = normalizeLiveKitUrls(requiredEnv("LIVEKIT_URL"));
  cachedConfig = {
    serverUrl: urls.serverUrl,
    clientUrl: urls.clientUrl,
    apiKey: requiredEnv("LIVEKIT_API_KEY"),
    apiSecret: requiredEnv("LIVEKIT_API_SECRET"),
    webhookKey: (process.env.LIVEKIT_WEBHOOK_KEY ?? "").trim() || requiredEnv("LIVEKIT_API_KEY"),
    webhookSecret:
      (process.env.LIVEKIT_WEBHOOK_SECRET ?? "").trim() || requiredEnv("LIVEKIT_API_SECRET"),
  };
  return cachedConfig;
}

export function getLiveKitEgressConfig(): LiveKitEgressConfig {
  if (cachedEgressConfig) return cachedEgressConfig;
  const egressBucket =
    (process.env.LIVEKIT_EGRESS_GCS_BUCKET ?? "").trim() ||
    (process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? "").trim();
  if (!egressBucket) {
    throw new Error("Missing required env var: LIVEKIT_EGRESS_GCS_BUCKET");
  }
  cachedEgressConfig = {
    egressBucket,
    egressPrefix: (process.env.LIVEKIT_EGRESS_GCS_PREFIX ?? "live-recordings").trim(),
    egressCredentials: resolveEgressCredentials(),
  };
  return cachedEgressConfig;
}

function getRoomServiceClient(): RoomServiceClient {
  if (cachedRoomServiceClient) return cachedRoomServiceClient;
  const config = getLiveKitConfig();
  cachedRoomServiceClient = new RoomServiceClient(
    config.serverUrl,
    config.apiKey,
    config.apiSecret,
  );
  return cachedRoomServiceClient;
}

function getEgressClient(): EgressClient {
  if (cachedEgressClient) return cachedEgressClient;
  const config = getLiveKitConfig();
  cachedEgressClient = new EgressClient(config.serverUrl, config.apiKey, config.apiSecret);
  return cachedEgressClient;
}

export function getWebhookReceiver(): WebhookReceiver {
  if (cachedWebhookReceiver) return cachedWebhookReceiver;
  const config = getLiveKitConfig();
  cachedWebhookReceiver = new WebhookReceiver(config.webhookKey, config.webhookSecret);
  return cachedWebhookReceiver;
}

export async function ensureLiveKitRoom(roomName: string): Promise<void> {
  if (!roomName.trim()) {
    throw new Error("roomName es requerido");
  }
  const roomService = getRoomServiceClient();
  const existing = await roomService.listRooms([roomName]);
  if (existing.some((room) => room.name === roomName)) return;
  await roomService.createRoom({
    name: roomName,
    emptyTimeout: 60 * 60,
    departureTimeout: 60 * 10,
  });
}

function isLiveKitNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };

  if (candidate.status === 404) return true;
  const code = typeof candidate.code === "string" ? candidate.code.trim().toLowerCase() : "";
  if (code.includes("not_found")) return true;

  const message =
    typeof candidate.message === "string" ? candidate.message.trim().toLowerCase() : "";
  return message.includes("not found") || message.includes("does not exist");
}

export async function closeLiveKitRoom(roomName: string): Promise<boolean> {
  const normalizedRoomName = roomName.trim();
  if (!normalizedRoomName) return false;
  try {
    await getRoomServiceClient().deleteRoom(normalizedRoomName);
    return true;
  } catch (error) {
    if (isLiveKitNotFoundError(error)) return false;
    throw error;
  }
}

export async function stopLiveKitEgress(egressId: string): Promise<boolean> {
  const normalizedEgressId = egressId.trim();
  if (!normalizedEgressId) return false;
  try {
    await getEgressClient().stopEgress(normalizedEgressId);
    return true;
  } catch (error) {
    if (isLiveKitNotFoundError(error)) return false;
    throw error;
  }
}

function parseParticipantRoleFromMetadata(rawMetadata: string | null | undefined): string {
  const value = (rawMetadata ?? "").trim();
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const role = (parsed as Record<string, unknown>).role;
      return typeof role === "string" ? role.trim().toLowerCase() : "";
    }
  } catch {
    // ignore malformed metadata
  }
  return "";
}

export async function isTeacherConnectedInRoom(roomName: string): Promise<boolean> {
  const normalizedRoomName = roomName.trim();
  if (!normalizedRoomName) return false;

  try {
    const participants = await getRoomServiceClient().listParticipants(normalizedRoomName);
    return participants.some((participant) => {
      const role = parseParticipantRoleFromMetadata(participant.metadata);
      return role === "teacher";
    });
  } catch {
    return false;
  }
}

export async function createJoinToken(params: {
  roomName: string;
  identity: string;
  participantName: string;
  metadata: Record<string, string>;
  isTeacher: boolean;
  ttl?: string;
}): Promise<string> {
  const config = getLiveKitConfig();
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: params.identity,
    name: params.participantName,
    ttl: params.ttl ?? "2h",
    metadata: JSON.stringify(params.metadata),
    attributes: params.metadata,
  });

  token.addGrant({
    roomJoin: true,
    room: params.roomName,
    roomAdmin: params.isTeacher,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return token.toJwt();
}

function normalizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}

export function buildRecordingObjectPath(params: {
  courseId: string;
  classId: string;
  startedAtMs: number;
}): string {
  const rawPrefix = (process.env.LIVEKIT_EGRESS_GCS_PREFIX ?? "live-recordings").trim();
  const prefix = normalizePathSegment(rawPrefix || "live-recordings");
  const date = new Date(params.startedAtMs);
  const yyyy = date.getUTCFullYear().toString();
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  const fileName = `${params.classId}-${params.startedAtMs}.mp4`;
  return [prefix, params.courseId, yyyy, mm, dd, fileName].filter(Boolean).join("/");
}

export async function startRoomCompositeRecording(params: {
  roomName: string;
  objectPath: string;
}): Promise<EgressInfo> {
  const egressConfig = getLiveKitEgressConfig();
  const output = new EncodedFileOutput({
    filepath: normalizePathSegment(params.objectPath),
    output: {
      case: "gcp",
      value: new GCPUpload({
        credentials: egressConfig.egressCredentials,
        bucket: egressConfig.egressBucket,
      }),
    },
  });

  const egressClient = getEgressClient();
  return egressClient.startRoomCompositeEgress(
    params.roomName,
    { file: output },
    {
      layout: "grid",
      encodingOptions: EncodingOptionsPreset.H264_1080P_30,
    },
  );
}

export function extractRecordingObjectPath(egressInfo: EgressInfo): string | null {
  const result = egressInfo.fileResults?.[0];
  if (!result) return null;

  const location = (result.location ?? "").trim();
  if (location.startsWith("gs://")) {
    const withoutScheme = location.slice("gs://".length);
    const slashIdx = withoutScheme.indexOf("/");
    if (slashIdx >= 0) {
      return withoutScheme.slice(slashIdx + 1) || null;
    }
  }

  const filename = (result.filename ?? "").trim();
  if (filename) {
    return normalizePathSegment(filename) || null;
  }
  return null;
}
