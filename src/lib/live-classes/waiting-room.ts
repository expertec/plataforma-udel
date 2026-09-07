import type {
  LiveClassSession,
  LiveWaitingRoomParticipant,
  LiveWaitingRoomParticipantStatus,
} from "@/lib/live-classes/types";

export const LIVE_WAITING_ROOM_PARTICIPANTS_COLLECTION = "waitingRoomParticipants";

export type LiveWaitingRoomParticipantSummary = {
  uid: string;
  displayName: string;
  email: string;
  status: LiveWaitingRoomParticipantStatus;
  requestedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  updatedAt: string | null;
};

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asWaitingRoomStatus(value: unknown): LiveWaitingRoomParticipantStatus {
  if (value === "admitted" || value === "rejected") return value;
  return "pending";
}

function asNullableString(value: unknown): string | null {
  const normalized = asTrimmedString(value);
  return normalized || null;
}

export function normalizeWaitingRoomParticipantData(
  uid: string,
  value: unknown,
): LiveWaitingRoomParticipant | null {
  const normalizedUid = asTrimmedString(uid);
  if (!normalizedUid || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  return {
    uid: normalizedUid,
    displayName: asTrimmedString(raw.displayName) || asTrimmedString(raw.name) || "Alumno",
    email: asTrimmedString(raw.email),
    status: asWaitingRoomStatus(raw.status),
    requestedAt: asNullableString(raw.requestedAt),
    decidedAt: asNullableString(raw.decidedAt),
    decidedBy: asNullableString(raw.decidedBy),
    updatedAt: asNullableString(raw.updatedAt),
  };
}

export function toWaitingRoomParticipantSummary(
  participant: LiveWaitingRoomParticipant,
): LiveWaitingRoomParticipantSummary {
  return {
    uid: participant.uid,
    displayName: participant.displayName,
    email: participant.email,
    status: participant.status,
    requestedAt: participant.requestedAt,
    decidedAt: participant.decidedAt,
    decidedBy: participant.decidedBy,
    updatedAt: participant.updatedAt,
  };
}

function getWaitingRoomParticipantRef(
  classRef: FirebaseFirestore.DocumentReference,
  uid: string,
): FirebaseFirestore.DocumentReference {
  return classRef.collection(LIVE_WAITING_ROOM_PARTICIPANTS_COLLECTION).doc(uid);
}

export async function loadWaitingRoomParticipant(params: {
  classRef: FirebaseFirestore.DocumentReference;
  uid: string;
  session: LiveClassSession;
}): Promise<LiveWaitingRoomParticipant | null> {
  const uid = asTrimmedString(params.uid);
  if (!uid) return null;

  const participantSnap = await getWaitingRoomParticipantRef(params.classRef, uid).get();
  const participant = normalizeWaitingRoomParticipantData(uid, participantSnap.data());
  if (participant) return participant;

  return params.session.waitingRoom.participants[uid] ?? null;
}

export async function upsertWaitingRoomParticipant(params: {
  classRef: FirebaseFirestore.DocumentReference;
  participant: LiveWaitingRoomParticipant;
}): Promise<void> {
  await getWaitingRoomParticipantRef(params.classRef, params.participant.uid).set(
    params.participant,
    { merge: true },
  );
}

export async function updateWaitingRoomParticipantStatus(params: {
  classRef: FirebaseFirestore.DocumentReference;
  uid: string;
  nextStatus: "admitted" | "rejected";
  decidedBy: string;
}): Promise<LiveWaitingRoomParticipantSummary | null> {
  const uid = asTrimmedString(params.uid);
  if (!uid) return null;

  const participantRef = getWaitingRoomParticipantRef(params.classRef, uid);
  const participantSnap = await participantRef.get();
  const current = normalizeWaitingRoomParticipantData(uid, participantSnap.data());
  if (!current) return null;

  const nowIso = new Date().toISOString();
  const nextParticipant: LiveWaitingRoomParticipant = {
    ...current,
    status: params.nextStatus,
    decidedAt: nowIso,
    decidedBy: params.decidedBy,
    updatedAt: nowIso,
  };

  await participantRef.set(nextParticipant, { merge: true });
  return toWaitingRoomParticipantSummary(nextParticipant);
}

export async function admitAllWaitingRoomParticipantDocs(params: {
  classRef: FirebaseFirestore.DocumentReference;
  decidedBy: string;
}): Promise<LiveWaitingRoomParticipantSummary[]> {
  const waitingSnap = await params.classRef
    .collection(LIVE_WAITING_ROOM_PARTICIPANTS_COLLECTION)
    .where("status", "==", "pending")
    .get();
  if (waitingSnap.empty) return [];

  const nowIso = new Date().toISOString();
  const updatedParticipants: LiveWaitingRoomParticipantSummary[] = [];
  const writes: Array<{
    ref: FirebaseFirestore.DocumentReference;
    participant: LiveWaitingRoomParticipant;
  }> = [];

  waitingSnap.docs.forEach((participantDoc) => {
    const current = normalizeWaitingRoomParticipantData(participantDoc.id, participantDoc.data());
    if (!current) return;
    const nextParticipant: LiveWaitingRoomParticipant = {
      ...current,
      status: "admitted",
      decidedAt: nowIso,
      decidedBy: params.decidedBy,
      updatedAt: nowIso,
    };
    updatedParticipants.push(toWaitingRoomParticipantSummary(nextParticipant));
    writes.push({
      ref: participantDoc.ref,
      participant: nextParticipant,
    });
  });

  for (let index = 0; index < writes.length; index += 450) {
    const batch = params.classRef.firestore.batch();
    writes.slice(index, index + 450).forEach((write) => {
      batch.set(write.ref, write.participant, { merge: true });
    });
    await batch.commit();
  }

  return updatedParticipants;
}

export async function listPendingWaitingRoomParticipantSummaries(params: {
  classRef: FirebaseFirestore.DocumentReference;
  session: LiveClassSession | null;
}): Promise<LiveWaitingRoomParticipantSummary[]> {
  const participantsByUid = new Map<string, LiveWaitingRoomParticipant>();
  Object.values(params.session?.waitingRoom.participants ?? {})
    .filter((participant) => participant.status === "pending")
    .forEach((participant) => {
      participantsByUid.set(participant.uid, participant);
    });

  const waitingSnap = await params.classRef
    .collection(LIVE_WAITING_ROOM_PARTICIPANTS_COLLECTION)
    .where("status", "==", "pending")
    .get();
  waitingSnap.docs.forEach((participantDoc) => {
    const participant = normalizeWaitingRoomParticipantData(participantDoc.id, participantDoc.data());
    if (participant) {
      participantsByUid.set(participant.uid, participant);
    }
  });

  return Array.from(participantsByUid.values())
    .map(toWaitingRoomParticipantSummary)
    .sort((left, right) => {
      const leftMs = left.requestedAt ? new Date(left.requestedAt).getTime() : 0;
      const rightMs = right.requestedAt ? new Date(right.requestedAt).getTime() : 0;
      return leftMs - rightMs;
    });
}
