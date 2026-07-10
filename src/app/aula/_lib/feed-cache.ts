import type { StudentFeed } from "./feed-loader";

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

const cacheKey = (uid: string) => `aulaFeed:${uid}`;

export type CachedAula = {
  feed: StudentFeed;
  forumDone: Record<string, boolean>;
};

type CacheEnvelope = CachedAula & {
  version: number;
  savedAt: number;
};

/**
 * Caché de sesión del contenido y del estado del foro (el progreso nunca se
 * cachea aquí: se siembra desde localStorage y se relee de Firestore).
 * Permite pintar de inmediato al recargar mientras se revalida en paralelo.
 *
 * Se cachea el foro junto al contenido porque el gating lo necesita: sin él, las
 * clases posteriores a un foro aparecerían bloqueadas durante un instante.
 */
export const loadCachedAula = (uid: string): CachedAula | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(cacheKey(uid));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CacheEnvelope>;
    if (parsed.version !== CACHE_VERSION || typeof parsed.savedAt !== "number") return null;
    if (Date.now() - parsed.savedAt > CACHE_MAX_AGE_MS) return null;
    if (!parsed.feed || !Array.isArray(parsed.feed.classes) || parsed.feed.classes.length === 0) {
      return null;
    }
    return { feed: parsed.feed, forumDone: parsed.forumDone ?? {} };
  } catch {
    return null;
  }
};

export const saveCachedAula = (uid: string, data: CachedAula) => {
  if (typeof window === "undefined") return;
  try {
    const payload: CacheEnvelope = { ...data, version: CACHE_VERSION, savedAt: Date.now() };
    sessionStorage.setItem(cacheKey(uid), JSON.stringify(payload));
  } catch {
    // Si no hay espacio o el modo privado lo impide, seguimos sin caché.
  }
};
