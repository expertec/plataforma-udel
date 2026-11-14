import { Parser } from "htmlparser2";
import { parseMaterialLink, type MaterialLink } from "@/lib/live-classes/materials";

const MAX_METADATA_BYTES = 512 * 1024;
const cache = new Map<string, { title: string | null; expiresAt: number }>();
const pending = new Map<string, Promise<string | null>>();

export function cleanMaterialTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ")
    .replace(/\s+[-–—|]\s+(?:Google (?:Sheets|Slides|Docs|Drive)|YouTube)\s*$/i, "").trim().slice(0, 180);
  if (!title || /^(?:Google (?:Sheets|Slides|Docs|Drive)|YouTube|Sign in|Sign in - Google Accounts|Google Drive: Sign-in|Acceder|Iniciar sesión|Acceso denegado|Access denied|Page not found|Error 404)$/i.test(title) || /^(?:Sign in|Acceder|Iniciar sesión)\s*[-–—|:]\s*(?:Google Accounts|Cuentas de Google)$/i.test(title)) return null;
  return title;
}

export function extractMaterialHtmlTitle(html: string): string | null {
  let inTitle = false;
  let text = "";
  let ogTitle: string | undefined;
  let twitterTitle: string | undefined;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (name === "title") inTitle = true;
      if (name !== "meta") return;
      const property = (attrs.property ?? attrs.name ?? "").toLowerCase();
      if (property === "og:title" && !ogTitle) ogTitle = attrs.content?.slice(0, 1000);
      if (property === "twitter:title" && !twitterTitle) twitterTitle = attrs.content?.slice(0, 1000);
    },
    ontext(value) { if (inTitle && text.length < 1000) text += value.slice(0, 1000 - text.length); },
    onclosetag(name) { if (name === "title") inTitle = false; },
  }, { decodeEntities: true });
  parser.end(html);
  return cleanMaterialTitle(ogTitle) ?? cleanMaterialTitle(twitterTitle) ?? cleanMaterialTitle(text);
}

async function readMetadata(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (bytes < MAX_METADATA_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const allowed = chunk.value.subarray(0, MAX_METADATA_BYTES - bytes);
      text += decoder.decode(allowed, { stream: true });
      bytes += allowed.byteLength;
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

async function requestTitle(link: MaterialLink): Promise<string | null> {
  let target = link.kind === "youtube"
    ? new URL(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(link.url)}`)
    : new URL(link.url);
  const signal = AbortSignal.timeout(6000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(target, {
      redirect: "manual", cache: "no-store", signal,
      headers: { Accept: link.kind === "youtube" ? "application/json" : "text/html", "User-Agent": "UdelX-Material-Preview/1.0" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location || link.kind === "youtube") return null;
      const next = new URL(location, target);
      // Never follow Google sign-in, consent, external redirects or arbitrary hosts.
      if (next.protocol !== "https:" || !parseMaterialLink(next.toString())?.kind.startsWith("google_")) return null;
      target = next;
      continue;
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
    const text = await readMetadata(response);
    if (link.kind === "youtube") {
      try { return cleanMaterialTitle((JSON.parse(text) as { title?: unknown }).title); } catch { return null; }
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return null;
    return extractMaterialHtmlTitle(text);
  }
  return null;
}

/** Public metadata only: no Google credentials, cookies or arbitrary URL requests. */
export async function resolveMaterialLinkTitle(rawUrl: string): Promise<string | null> {
  const link = parseMaterialLink(rawUrl);
  if (!link) return null;
  const saved = cache.get(link.url);
  if (saved && saved.expiresAt > Date.now()) return saved.title;
  const inFlight = pending.get(link.url);
  if (inFlight) return inFlight;
  const lookup = requestTitle(link).catch(() => null).then((title) => {
    if (cache.size >= 500) cache.delete(cache.keys().next().value!);
    cache.set(link.url, { title, expiresAt: Date.now() + (title ? 6 * 60 * 60 * 1000 : 60 * 1000) });
    return title;
  }).finally(() => pending.delete(link.url));
  pending.set(link.url, lookup);
  return lookup;
}
