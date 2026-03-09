import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth, getAdminFirestore } from "@/lib/firebase/admin";
import { sendWhatsAppTextToStudent } from "@/lib/server/whatsapp-notifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UserRole =
  | "teacher"
  | "student"
  | "adminTeacher"
  | "superAdminTeacher"
  | "coordinadorPlantel";

type ForumReplyNotificationRequest = {
  courseId?: string;
  lessonId?: string;
  classId?: string;
  postId?: string;
  replyId?: string;
};

class RouteAccessError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asUserRole(value: unknown): UserRole | null {
  if (
    value === "teacher" ||
    value === "student" ||
    value === "adminTeacher" ||
    value === "superAdminTeacher" ||
    value === "coordinadorPlantel"
  ) {
    return value;
  }
  return null;
}

function extractBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const trimmed = authorizationHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token || null;
}

function toSnippet(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 117)}...`;
}

async function resolveRequester(
  request: NextRequest,
): Promise<{ uid: string; role: UserRole }> {
  const token = extractBearerToken(request.headers.get("authorization"));
  if (!token) {
    throw new RouteAccessError(401, "Authorization Bearer token requerido");
  }

  let decodedToken: Awaited<ReturnType<ReturnType<typeof getAdminAuth>["verifyIdToken"]>>;
  try {
    decodedToken = await getAdminAuth().verifyIdToken(token);
  } catch {
    throw new RouteAccessError(401, "Token inválido o expirado");
  }

  const uid = decodedToken.uid;
  const userSnap = await getAdminFirestore().collection("users").doc(uid).get();
  const roleFromDoc = asUserRole(userSnap.data()?.role);
  const roleFromClaims = asUserRole(decodedToken.role);
  const role = roleFromDoc ?? roleFromClaims;
  if (!role) {
    throw new RouteAccessError(403, "No tienes permisos para usar notificaciones");
  }

  return { uid, role };
}

function buildForumReplyMessage(params: {
  authorName: string;
  classTitle?: string;
  courseTitle?: string;
  lessonTitle?: string;
  replyText: string;
}): string {
  const authorName = params.authorName || "Alguien";
  const classTitle = params.classTitle || "foro";
  const contextParts = [params.courseTitle, params.lessonTitle]
    .map((part) => asText(part))
    .filter(Boolean);
  const contextText = contextParts.length ? contextParts.join(" • ") : "";
  const contextLine = contextText ? `\n📚 Contexto: ${contextText}` : "";
  const snippet = toSnippet(params.replyText);

  return (
    `💬 *Nuevo comentario en tu aportación*\n` +
    `\n` +
    `👤 ${authorName} comentó en:\n` +
    `🧩 Foro: ${classTitle}${contextLine}\n` +
    `\n` +
    `🗨️ Comentario:\n` +
    `"${snippet}"\n` +
    `\n` +
    `Ingresa a la plataforma para responder.`
  );
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof RouteAccessError) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: error.status },
    );
  }
  console.error("Error notificando respuesta de foro por WhatsApp", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 },
  );
}

export async function POST(request: NextRequest) {
  try {
    const requester = await resolveRequester(request);
    const body = (await request.json()) as ForumReplyNotificationRequest;
    const courseId = asText(body.courseId);
    const lessonId = asText(body.lessonId);
    const classId = asText(body.classId);
    const postId = asText(body.postId);
    const replyId = asText(body.replyId);
    if (!courseId || !lessonId || !classId || !postId || !replyId) {
      throw new RouteAccessError(
        400,
        "courseId, lessonId, classId, postId y replyId son requeridos",
      );
    }

    const db = getAdminFirestore();
    const replyRef = db
      .collection("courses")
      .doc(courseId)
      .collection("lessons")
      .doc(lessonId)
      .collection("classes")
      .doc(classId)
      .collection("forums")
      .doc(postId)
      .collection("replies")
      .doc(replyId);
    const replySnap = await replyRef.get();
    if (!replySnap.exists) {
      throw new RouteAccessError(404, "Respuesta del foro no encontrada");
    }
    const replyData = replySnap.data() ?? {};
    const replyAuthorId = asText(replyData.authorId);
    if (!replyAuthorId || replyAuthorId !== requester.uid) {
      throw new RouteAccessError(403, "No puedes notificar una respuesta que no es tuya");
    }

    const postRef = db
      .collection("courses")
      .doc(courseId)
      .collection("lessons")
      .doc(lessonId)
      .collection("classes")
      .doc(classId)
      .collection("forums")
      .doc(postId);
    const postSnap = await postRef.get();
    if (!postSnap.exists) {
      throw new RouteAccessError(404, "Aportación de foro no encontrada");
    }
    const postData = postSnap.data() ?? {};
    const postAuthorId = asText(postData.authorId);
    if (!postAuthorId) {
      throw new RouteAccessError(400, "La aportación no tiene autor");
    }
    if (postAuthorId === requester.uid) {
      return NextResponse.json(
        {
          success: true,
          data: {
            notified: false,
            reason: "No se notifica cuando te respondes a ti mismo",
          },
        },
        { status: 200 },
      );
    }

    const eventId = [
      "forumReply",
      courseId,
      lessonId,
      classId,
      postId,
      replyId,
    ].join(":");
    const eventRef = db.collection("whatsappNotificationEvents").doc(eventId);
    const eventSnap = await eventRef.get();
    if (eventSnap.exists) {
      return NextResponse.json(
        {
          success: true,
          data: {
            notified: false,
            reason: "Notificación ya enviada para esta respuesta",
          },
        },
        { status: 200 },
      );
    }

    const [courseSnap, lessonSnap, classSnap] = await Promise.all([
      db.collection("courses").doc(courseId).get(),
      db.collection("courses").doc(courseId).collection("lessons").doc(lessonId).get(),
      db
        .collection("courses")
        .doc(courseId)
        .collection("lessons")
        .doc(lessonId)
        .collection("classes")
        .doc(classId)
        .get(),
    ]);

    const message = buildForumReplyMessage({
      authorName: asText(replyData.authorName) || "Alguien",
      classTitle:
        asText(classSnap.data()?.title) ||
        asText(postData.classTitle) ||
        asText(postData.title) ||
        "foro",
      courseTitle: asText(courseSnap.data()?.title) || undefined,
      lessonTitle: asText(lessonSnap.data()?.title) || undefined,
      replyText: asText(replyData.text) || "Tienes un nuevo comentario",
    });

    const outcome = await sendWhatsAppTextToStudent({
      studentId: postAuthorId,
      message,
      preferredOwnerUid: requester.uid,
    });

    if (outcome.notified) {
      await eventRef.set({
        type: "forumReply",
        courseId,
        lessonId,
        classId,
        postId,
        replyId,
        targetUserId: postAuthorId,
        triggeredBy: requester.uid,
        createdAt: new Date(),
        messageId: outcome.messageId ?? null,
      });
    }

    return NextResponse.json(
      {
        success: true,
        data: outcome,
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
