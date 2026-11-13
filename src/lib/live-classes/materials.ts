export type LiveMaterialKind = "pdf" | "word" | "powerpoint" | "image" | "video" | "youtube";

export type LiveMaterial = {
  id: string;
  name: string;
  kind: LiveMaterialKind;
  url: string;
  size: number;
  createdAt: number;
  youtubeId?: string;
  textPages?: string[];
  slideCount?: number;
};

export type MaterialPresentation = {
  materialId: string | null;
  page: number;
  playing: boolean;
  position: number;
  updatedAt: number;
  revision: number;
  sessionKey: string;
};

export type LiveMaterialsSnapshot = {
  materials: LiveMaterial[];
  activeMaterial: LiveMaterial | null;
  presentation: MaterialPresentation;
  serverTime: number;
};

export const MATERIAL_TYPES: Record<string, { kind: LiveMaterialKind; mime: string; maxSize: number }> = {
  pdf: { kind: "pdf", mime: "application/pdf", maxSize: 20 * 1024 * 1024 },
  docx: { kind: "word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", maxSize: 10 * 1024 * 1024 },
  pptx: { kind: "powerpoint", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", maxSize: 50 * 1024 * 1024 },
  jpg: { kind: "image", mime: "image/jpeg", maxSize: 20 * 1024 * 1024 },
  jpeg: { kind: "image", mime: "image/jpeg", maxSize: 20 * 1024 * 1024 },
  png: { kind: "image", mime: "image/png", maxSize: 20 * 1024 * 1024 },
  webp: { kind: "image", mime: "image/webp", maxSize: 20 * 1024 * 1024 },
  gif: { kind: "image", mime: "image/gif", maxSize: 20 * 1024 * 1024 },
  mp4: { kind: "video", mime: "video/mp4", maxSize: 200 * 1024 * 1024 },
  webm: { kind: "video", mime: "video/webm", maxSize: 200 * 1024 * 1024 },
};

export const MATERIAL_ACCEPT = ".pdf,.docx,.pptx,.jpg,.jpeg,.png,.webp,.gif,.mp4,.webm";

export function getMaterialFileType(name: string, size: number) {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const type = Object.hasOwn(MATERIAL_TYPES, extension) ? MATERIAL_TYPES[extension] : null;
  if (!type) throw new Error("Formato no compatible. Usa PDF, Word (.docx), PowerPoint (.pptx), imágenes, MP4 o WebM.");
  if (!Number.isSafeInteger(size) || size <= 0 || size > type.maxSize) {
    throw new Error(`El archivo debe pesar entre 1 byte y ${type.maxSize / 1024 / 1024} MB.`);
  }
  return type;
}

export function parseYouTubeId(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let id: string | null = null;
    if (host === "youtu.be") id = url.pathname.split("/")[1];
    if (["youtube.com", "m.youtube.com", "youtube-nocookie.com"].includes(host)) {
      id = url.pathname === "/watch" ? url.searchParams.get("v") :
        /^\/(embed|shorts|live)\//.test(url.pathname) ? url.pathname.split("/")[2] : null;
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function emptyPresentation(sessionKey = ""): MaterialPresentation {
  return { materialId: null, page: 1, playing: false, position: 0, updatedAt: 0, revision: 0, sessionKey };
}

export function presentationPosition(state: MaterialPresentation, now: number): number {
  return Math.max(0, state.position + (state.playing ? Math.max(0, now - state.updatedAt) / 1000 : 0));
}

export function splitWordText(text: string): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) throw new Error("El documento no contiene texto para presentar. Prueba subirlo como PDF.");
  if (cleaned.length > 200_000) throw new Error("El documento es demasiado largo. Divídelo en archivos más pequeños.");
  const pages: string[] = [];
  let remaining = cleaned;
  while (remaining.length > 3000) {
    const newline = remaining.lastIndexOf("\n", 3000);
    const space = remaining.lastIndexOf(" ", 3000);
    const end = newline > 1500 ? newline : space > 1500 ? space : 3000;
    pages.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) pages.push(remaining);
  return pages;
}

export function validatePresentationControl(input: Record<string, unknown>) {
  if (input.page !== undefined && (!Number.isSafeInteger(input.page) || Number(input.page) < 1 || Number(input.page) > 10000)) {
    throw new Error("Página inválida.");
  }
  if (input.position !== undefined && (typeof input.position !== "number" || !Number.isFinite(input.position) || input.position < 0 || input.position > 604800)) {
    throw new Error("Posición de reproducción inválida.");
  }
  if (input.playing !== undefined && typeof input.playing !== "boolean") throw new Error("Estado de reproducción inválido.");
  return {
    ...(input.page !== undefined ? { page: Number(input.page) } : {}),
    ...(input.position !== undefined ? { position: Number(input.position) } : {}),
    ...(input.playing !== undefined ? { playing: input.playing as boolean } : {}),
  };
}
