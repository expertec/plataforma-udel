import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAdminApp, getAdminFirestore } from "@/lib/firebase/admin";
import { validatePowerPointArchive } from "@/lib/server/live-material-powerpoint";
import { LiveAccessError, resolveAuthorizedLiveClassAccess, toLiveAccessErrorResponse } from "@/lib/live-classes/access";
import {
  emptyPresentation, getMaterialFileType, parseMaterialLink, presentationPosition,
  splitWordText, validatePresentationControl,
  type LiveMaterial, type MaterialPresentation,
} from "@/lib/live-classes/materials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ classId: string }> };
type StoredMaterial = LiveMaterial & {
  status: "pending" | "ready";
  storagePath?: string;
  bucketName?: string;
  contentType?: string;
  uploadedBy: string;
};

async function access(request: NextRequest, context: Context, requireTeacher = false) {
  const { classId } = await context.params;
  return resolveAuthorizedLiveClassAccess({
    request, classId,
    courseId: request.nextUrl.searchParams.get("courseId") ?? undefined,
    lessonId: request.nextUrl.searchParams.get("lessonId") ?? undefined,
    requireTeacher, allowCoordinatorAccess: true, allowLiveLinkStudentFallback: true,
  });
}

function publicMaterial(data: StoredMaterial, includeText = true): LiveMaterial {
  return {
    id: data.id, name: data.name, kind: data.kind, url: data.url,
    size: data.size, createdAt: data.createdAt,
    ...(data.youtubeId ? { youtubeId: data.youtubeId } : {}),
    ...(includeText && data.textPages ? { textPages: data.textPages } : {}),
    ...(data.slideCount ? { slideCount: data.slideCount } : {}),
  };
}

function fail(error: unknown) {
  const result = toLiveAccessErrorResponse(error);
  return NextResponse.json({ success: false, error: result.message }, { status: result.status });
}

function validate<T>(fn: () => T): T {
  try { return fn(); } catch (error) {
    throw new LiveAccessError(400, error instanceof Error ? error.message : "Datos inválidos.");
  }
}

function materialRefId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new LiveAccessError(400, "Material inválido.");
  }
  return value;
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const { classContext, accessRole } = await access(request, context);
    const collection = classContext.classRef.collection("liveMaterials");
    const stateSnap = await classContext.classRef.collection("liveMaterialState").doc("current").get();
    const sessionKey = classContext.liveSession?.lastStartedAt ?? "";
    const storedState = stateSnap.data() as MaterialPresentation | undefined;
    const isLive = classContext.liveSession?.status === "live";
    const presentation = isLive && storedState?.sessionKey === sessionKey ? storedState : emptyPresentation(sessionKey);
    let activeMaterial: LiveMaterial | null = null;
    if (presentation.materialId) {
      const activeSnap = await collection.doc(presentation.materialId).get();
      const data = activeSnap.data() as StoredMaterial | undefined;
      if (data?.status === "ready") activeMaterial = publicMaterial(data);
    }
    const materials: LiveMaterial[] = [];
    if (accessRole === "teacher") {
      const snapshots = await collection.where("status", "==", "ready").limit(100).get();
      snapshots.docs.forEach((doc) => materials.push(publicMaterial(doc.data() as StoredMaterial, false)));
      materials.sort((a, b) => a.createdAt - b.createdAt);
    }
    return NextResponse.json({ success: true, data: { materials, activeMaterial, presentation, serverTime: Date.now() } }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) { return fail(error); }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const { user, classContext } = await access(request, context, true);
    let body: Record<string, unknown>;
    try { body = await request.json(); } catch { throw new LiveAccessError(400, "Solicitud inválida."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new LiveAccessError(400, "Solicitud inválida.");
    const db = getAdminFirestore();
    const collection = classContext.classRef.collection("liveMaterials");
    const stateRef = classContext.classRef.collection("liveMaterialState").doc("current");
    const sessionKey = classContext.liveSession?.lastStartedAt ?? "";

    if (body.action === "upload" || body.action === "youtube" || body.action === "link") {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 180) : "";
      const isLink = body.action !== "upload";
      const link = isLink && typeof body.url === "string" ? parseMaterialLink(body.url) : null;
      if (isLink && (!link || (body.action === "youtube" && link.kind !== "youtube"))) throw new LiveAccessError(400, "Introduce un enlace válido de YouTube, Google Sheets, Slides, Docs o un archivo de Drive.");
      if (!isLink && !name) throw new LiveAccessError(400, "El archivo necesita un nombre.");
      const type = !isLink ? validate(() => getMaterialFileType(name, Number(body.size))) : null;
      const ref = collection.doc();
      const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || getAdminApp().options.storageBucket;
      if (!isLink && !bucketName) throw new LiveAccessError(500, "Falta configurar el almacenamiento de materiales.");
      const path = `live-materials/${classContext.courseId}/${classContext.lessonId}/${classContext.classId}/${ref.id}/source`;
      const downloadToken = randomUUID();
      const material: StoredMaterial = {
        id: ref.id, name: name || link?.label || "Material", kind: type?.kind ?? link!.kind,
        size: isLink ? 0 : Number(body.size), createdAt: Date.now(), uploadedBy: user.uid,
        status: isLink ? "ready" : "pending",
        url: isLink ? link!.url :
          `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName!)}/o/${encodeURIComponent(path)}?alt=media&token=${downloadToken}`,
        ...(isLink ? (link!.youtubeId ? { youtubeId: link!.youtubeId } : {}) : { storagePath: path, bucketName: bucketName!, contentType: type!.mime }),
      };
      await db.runTransaction(async (tx) => {
        const [ready, recent] = await Promise.all([
          tx.get(collection.where("status", "==", "ready").limit(50)),
          tx.get(collection.where("createdAt", ">", Date.now() - 86400000).limit(50)),
        ]);
        // Reserve slots for recent uploads without requiring a composite Firestore index.
        const ids = new Set([...ready.docs, ...recent.docs].map((doc) => doc.id));
        if (ids.size >= 50) throw new LiveAccessError(400, "Puedes guardar hasta 50 materiales por clase. Elimina alguno para agregar otro.");
        tx.create(ref, material);
      });
      if (isLink) return NextResponse.json({ success: true, data: { material: publicMaterial(material) } });
      try {
        const [uploadUrl] = await getAdminApp().storage().bucket(bucketName!).file(path).createResumableUpload({
          origin: request.nextUrl.origin,
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            contentType: type!.mime,
            contentLength: material.size,
            cacheControl: "private, max-age=3600",
            metadata: { firebaseStorageDownloadTokens: downloadToken },
          },
        });
        return NextResponse.json({ success: true, data: { id: ref.id, uploadUrl, contentType: type!.mime } });
      } catch (error) {
        await ref.delete();
        throw error;
      }
    }

    if (body.action === "complete") {
      const ref = collection.doc(materialRefId(body.materialId));
      const snap = await ref.get();
      const data = snap.data() as StoredMaterial | undefined;
      if (!data || data.uploadedBy !== user.uid || !data.storagePath || !data.bucketName) throw new LiveAccessError(404, "Carga no encontrada.");
      if (data.status === "ready") return NextResponse.json({ success: true });
      const file = getAdminApp().storage().bucket(data.bucketName).file(data.storagePath);
      const [metadata] = await file.getMetadata();
      if (Number(metadata.size) !== data.size || metadata.contentType !== data.contentType) {
        await file.delete({ ignoreNotFound: true });
        await ref.delete();
        throw new LiveAccessError(400, "El archivo recibido no coincide con la carga. Intenta de nuevo.");
      }
      const [head] = await file.download({ start: 0, end: 15 });
      const header = head.toString("latin1");
      const valid = data.kind === "pdf" ? header.startsWith("%PDF-") : data.kind === "word" || data.kind === "powerpoint" ? header.startsWith("PK") :
        data.contentType === "image/jpeg" ? head[0] === 0xff && head[1] === 0xd8 :
        data.contentType === "image/png" ? head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
        data.contentType === "image/gif" ? /^GIF8[79]a/.test(header) :
        data.contentType === "image/webp" ? header.startsWith("RIFF") && header.slice(8, 12) === "WEBP" :
        data.contentType === "video/mp4" ? header.slice(4, 8) === "ftyp" :
        data.contentType === "video/webm" ? head.subarray(0, 4).equals(Buffer.from([26,69,223,163])) : false;
      if (!valid) {
        await file.delete({ ignoreNotFound: true });
        await ref.delete();
        throw new LiveAccessError(400, "El contenido del archivo no corresponde a su formato.");
      }
      let textPages: string[] | undefined;
      let slideCount: number | undefined;
      if (data.kind === "powerpoint") {
        try {
          const [buffer] = await file.download();
          slideCount = await validatePowerPointArchive(buffer);
        } catch (error) {
          await file.delete({ ignoreNotFound: true });
          await ref.delete();
          throw new LiveAccessError(400, error instanceof Error ? error.message : "No se pudo leer PowerPoint. Usa un archivo .pptx válido.");
        }
      }
      if (data.kind === "word") {
        try {
          const [buffer] = await file.download();
          const mammoth = await import("mammoth");
          const result = await mammoth.extractRawText({ buffer });
          textPages = validate(() => splitWordText(result.value));
        } catch (error) {
          await file.delete({ ignoreNotFound: true });
          await ref.delete();
          throw error instanceof LiveAccessError ? error : new LiveAccessError(400, "No se pudo leer Word. Usa un archivo .docx válido o conviértelo a PDF.");
        }
      }
      await ref.update({ status: "ready", ...(textPages ? { textPages } : {}), ...(slideCount ? { slideCount } : {}) });
      return NextResponse.json({ success: true });
    }

    if (body.action === "delete") {
      const ref = collection.doc(materialRefId(body.materialId));
      let removed: StoredMaterial | undefined;
      await db.runTransaction(async (tx) => {
        const [snap, stateSnap] = await Promise.all([tx.get(ref), tx.get(stateRef)]);
        removed = snap.data() as StoredMaterial | undefined;
        if (!removed) throw new LiveAccessError(404, "Material no encontrado.");
        const state = stateSnap.data() as MaterialPresentation | undefined;
        if (state?.materialId === ref.id) tx.set(stateRef, { ...emptyPresentation(sessionKey), revision: (state.revision ?? 0) + 1, updatedAt: Date.now() });
        tx.delete(ref);
      });
      if (removed?.storagePath && removed.bucketName) {
        await getAdminApp().storage().bucket(removed.bucketName).file(removed.storagePath).delete({ ignoreNotFound: true }).catch((error) => {
          console.error("No se pudo limpiar el archivo de material eliminado", error);
        });
      }
      return NextResponse.json({ success: true });
    }

    if (["present", "control", "stop"].includes(String(body.action))) {
      if (classContext.liveSession?.status !== "live") throw new LiveAccessError(409, "Inicia la clase para presentar material.");
      const controls = validate(() => validatePresentationControl(body));
      await db.runTransaction(async (tx) => {
        const stateSnap = await tx.get(stateRef);
        const saved = stateSnap.data() as MaterialPresentation | undefined;
        const current = saved?.sessionKey === sessionKey ? saved : emptyPresentation(sessionKey);
        if (body.action === "control" && (body.materialId !== current.materialId || body.revision !== current.revision)) {
          throw new LiveAccessError(409, "La presentación cambió. Intenta otra vez.");
        }
        const id = body.action === "stop" ? null : materialRefId(body.action === "present" ? body.materialId : current.materialId);
        if (id) {
          const materialSnap = await tx.get(collection.doc(id));
          const material = materialSnap.data() as StoredMaterial | undefined;
          if (material?.status !== "ready") throw new LiveAccessError(404, "Material no encontrado.");
          if (controls.page && material.kind === "word" && controls.page > (material.textPages?.length ?? 1)) throw new LiveAccessError(400, "Sección inválida.");
          if (controls.page && material.kind === "powerpoint" && controls.page > (material.slideCount ?? 1)) throw new LiveAccessError(400, "Diapositiva inválida.");
        }
        const now = Date.now();
        const next: MaterialPresentation = body.action === "control" ? {
          ...current, position: presentationPosition(current, now), ...controls, updatedAt: now,
          revision: current.revision + 1,
        } : {
          ...emptyPresentation(sessionKey), materialId: id, updatedAt: now,
          revision: (saved?.revision ?? 0) + 1,
        };
        tx.set(stateRef, next);
      });
      return NextResponse.json({ success: true });
    }
    throw new LiveAccessError(400, "Acción no válida.");
  } catch (error) { return fail(error); }
}
