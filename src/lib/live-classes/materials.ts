export type GoogleMaterialKind = "google_sheets" | "google_slides" | "google_docs" | "google_drive";
export type LiveMaterialKind = "pdf" | "word" | "powerpoint" | "image" | "video" | "youtube" | GoogleMaterialKind;

export type MaterialLink = { kind: LiveMaterialKind; url: string; label: string; embedUrl?: string; youtubeId?: string };

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
  presenterPosition?: { x: number; y: number };
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

/** Convert supported sharing links to canonical Google previews; never embed arbitrary URLs. */
export function parseGoogleMaterialLink(input: string): MaterialLink | null {
  try {
    const source = new URL(input.trim());
    if (!["https:", "http:"].includes(source.protocol) || source.username || source.password || source.port) return null;
    const host = source.hostname.toLowerCase();
    if (host !== "docs.google.com" && host !== "drive.google.com") return null;
    const idPattern = /^[A-Za-z0-9_-]{5,256}$/;
    const resourceKey = source.searchParams.get("resourcekey");
    const withResourceKey = (target: URL) => {
      if (resourceKey && idPattern.test(resourceKey)) target.searchParams.set("resourcekey", resourceKey);
      return target;
    };
    if (host === "drive.google.com") {
      const match = source.pathname.match(/^\/file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|$)/);
      const id = match?.[1] ?? (["/open", "/uc"].includes(source.pathname) ? source.searchParams.get("id") : null);
      if (!id || !idPattern.test(id)) return null;
      return {
        kind: "google_drive", label: "Archivo de Google Drive",
        url: withResourceKey(new URL(`https://drive.google.com/file/d/${id}/view`)).toString(),
        embedUrl: withResourceKey(new URL(`https://drive.google.com/file/d/${id}/preview`)).toString(),
      };
    }
    const match = source.pathname.match(/^\/(spreadsheets|presentation|document)\/(?:u\/\d+\/)?d\/(e\/)?([A-Za-z0-9_-]+)(?:\/|$)/);
    if (!match || !idPattern.test(match[3])) return null;
    const [, app, published, id] = match;
    const base = `https://docs.google.com/${app}/d/${published ?? ""}${id}`;
    const hash = new URLSearchParams(source.hash.slice(1));
    if (app === "spreadsheets") {
      const gid = source.searchParams.get("gid") ?? hash.get("gid");
      const url = withResourceKey(new URL(`${base}/${published ? "pubhtml" : "edit"}`));
      const embed = withResourceKey(new URL(`${base}/${published ? "pubhtml" : "preview"}`));
      if (gid && /^\d{1,16}$/.test(gid)) { url.searchParams.set("gid", gid); embed.searchParams.set("gid", gid); }
      embed.searchParams.set("widget", "true");
      embed.searchParams.set("headers", "false");
      return { kind: "google_sheets", label: "Google Sheets", url: url.toString(), embedUrl: embed.toString() };
    }
    if (app === "presentation") {
      const slide = hash.get("slide");
      const url = withResourceKey(new URL(`${base}/${published ? "pub" : "edit"}`));
      const embed = withResourceKey(new URL(`${base}/embed`));
      embed.searchParams.set("start", "false");
      embed.searchParams.set("loop", "false");
      if (slide && /^id\.[A-Za-z0-9_.:-]{1,200}$/.test(slide)) { url.hash = `slide=${slide}`; embed.hash = `slide=${slide}`; }
      return { kind: "google_slides", label: "Google Slides", url: url.toString(), embedUrl: embed.toString() };
    }
    return {
      kind: "google_docs", label: "Google Docs",
      url: withResourceKey(new URL(`${base}/${published ? "pub" : "edit"}`)).toString(),
      embedUrl: withResourceKey(new URL(`${base}/${published ? "pub?embedded=true" : "preview"}`)).toString(),
    };
  } catch { return null; }
}

export function parseMaterialLink(input: string): MaterialLink | null {
  const youtubeId = parseYouTubeId(input.trim());
  if (youtubeId) return { kind: "youtube", label: "Video de YouTube", url: `https://www.youtube.com/watch?v=${youtubeId}`, youtubeId };
  return parseGoogleMaterialLink(input);
}

export function fallbackMaterialLinkName(link: MaterialLink): string {
  const id = link.youtubeId ?? new URL(link.url).pathname.split("/").filter(Boolean).at(-2) ?? "";
  return id ? `${link.label} · ${id.slice(-8)}` : link.label;
}

export function hasGenericMaterialTitle(material: Pick<LiveMaterial, "url" | "name">): boolean {
  const link = parseMaterialLink(material.url);
  return Boolean(link && (material.name === link.label || material.name.startsWith(`${link.label} · `)));
}

export function emptyPresentation(sessionKey = ""): MaterialPresentation {
  return { materialId: null, page: 1, playing: false, position: 0, updatedAt: 0, revision: 0, sessionKey, presenterPosition: { x: 0, y: 1 } };
}

export function validatePresenterPosition(value: unknown): { x: number; y: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Posición de cámara inválida.");
  const { x, y } = value as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error("Posición de cámara inválida.");
  return { x, y };
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
