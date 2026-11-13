"use client";

import type { User } from "firebase/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Film, ImageIcon, Link, Loader2, Presentation, Search, Trash2, Upload, X } from "lucide-react";
import { MATERIAL_ACCEPT, emptyPresentation, getMaterialFileType, parseYouTubeId, type LiveMaterial, type LiveMaterialsSnapshot } from "@/lib/live-classes/materials";

export function useLiveMaterials({ endpoint, user, enabled, live }: {
  endpoint: string; user: User | null; enabled: boolean; live: boolean;
}) {
  const [snapshot, setSnapshot] = useState<LiveMaterialsSnapshot>({
    materials: [], activeMaterial: null, presentation: emptyPresentation(), serverTime: 0,
  });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadLabel, setUploadLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const refreshSequence = useRef(0);
  const uploadRef = useRef<XMLHttpRequest | null>(null);
  const uploadSessionRef = useRef({ cancelled: false });
  const busyRef = useRef(false);

  const api = useCallback(async (body?: Record<string, unknown>) => {
    if (!user) throw new Error("Inicia sesión para usar los materiales.");
    const token = await user.getIdToken();
    const response = await fetch(endpoint, {
      method: body ? "POST" : "GET", cache: "no-store",
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || "No se pudieron consultar los materiales.");
    return payload.data;
  }, [endpoint, user]);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const start = Date.now();
    const data = await api() as LiveMaterialsSnapshot;
    if (sequence !== refreshSequence.current) return;
    setClockOffset(data.serverTime - (start + Date.now()) / 2);
    setSnapshot(data);
    setSyncError(null);
  }, [api]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const load = async () => {
      try { await refresh(); } catch (cause) {
        if (!disposed) setSyncError(cause instanceof Error ? cause.message : "No se pudo actualizar la presentación.");
      } finally { if (!disposed) setLoading(false); }
    };
    setLoading(true);
    void load();
    // LiveKit invalidates immediately after a change; polling recovers missed packets/reconnections.
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, live ? 8000 : 20000);
    const onVisible = () => { if (!document.hidden) void load(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      // This is a request generation counter, not a DOM ref; invalidate outstanding responses.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++refreshSequence.current;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, live, refresh]);

  useEffect(() => {
    setSnapshot({ materials: [], activeMaterial: null, presentation: emptyPresentation(), serverTime: 0 });
    const session = { cancelled: false };
    uploadSessionRef.current = session;
    return () => {
      session.cancelled = true;
      uploadRef.current?.abort();
    };
  }, [endpoint, user]);

  const action = useCallback(async (body: Record<string, unknown>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await api(body);
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo completar la acción.");
      void refresh().catch(() => {});
      return false;
    } finally { busyRef.current = false; setBusy(false); }
  }, [api, refresh]);

  const upload = useCallback(async (selection: File | File[]) => {
    if (busyRef.current) return false;
    const files = Array.isArray(selection) ? selection : [selection];
    if (!files.length) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    let uploaded = 0;
    const session = uploadSessionRef.current;
    try {
      for (const [index, file] of files.entries()) {
        if (session.cancelled) break;
        let pendingId: string | undefined;
        setUploadLabel(`${index + 1} de ${files.length}: ${file.name}`);
        setProgress(0);
        try {
          getMaterialFileType(file.name, file.size);
          const data = await api({ action: "upload", name: file.name, size: file.size }) as { id: string; uploadUrl: string; contentType: string };
          pendingId = data.id;
          if (session.cancelled) throw new Error("Carga cancelada.");
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            uploadRef.current = xhr;
            xhr.open("PUT", data.uploadUrl);
            xhr.setRequestHeader("Content-Type", data.contentType);
            xhr.timeout = 30 * 60 * 1000;
            xhr.upload.onprogress = (event) => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
            xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("No se pudo subir el archivo. Intenta de nuevo."));
            xhr.onerror = () => reject(new Error("La carga se interrumpió. Revisa tu conexión e intenta de nuevo."));
            xhr.ontimeout = () => reject(new Error("La carga tardó demasiado. Intenta de nuevo."));
            xhr.onabort = () => reject(new Error("Carga cancelada."));
            xhr.send(file);
          });
          await api({ action: "complete", materialId: pendingId });
          pendingId = undefined;
          uploaded += 1;
        } catch (cause) {
          if (pendingId) await api({ action: "delete", materialId: pendingId }).catch(() => {});
          failures.push(`${file.name}: ${cause instanceof Error ? cause.message : "No se pudo subir el material."}`);
        } finally { uploadRef.current = null; }
      }
      if (uploaded && !session.cancelled) {
        try { await refresh(); } catch {
          failures.push("Los archivos se guardaron, pero no se pudo actualizar la lista. Vuelve a abrir el panel.");
        }
      }
      if (failures.length) setError(failures.join("\n"));
      return uploaded > 0;
    } finally {
      busyRef.current = false;
      setBusy(false);
      setProgress(null);
      setUploadLabel(null);
    }
  }, [api, refresh]);

  return { ...snapshot, loading, busy, progress, uploadLabel, error, syncError, clockOffset, refresh, action, upload };
}

export type LiveMaterialsModel = ReturnType<typeof useLiveMaterials>;

export const MATERIAL_KIND_LABEL = { pdf: "PDF", word: "Word", powerpoint: "PowerPoint", image: "Imagen", video: "Video", youtube: "YouTube" };

function materialSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function MaterialIcon({ kind }: { kind: LiveMaterial["kind"] }) {
  const Icon = kind === "image" ? ImageIcon : kind === "youtube" ? Link : kind === "video" ? Film : kind === "powerpoint" ? Presentation : FileText;
  return <Icon className="h-5 w-5 shrink-0 text-sky-300" />;
}

export function LiveMaterialsPanel({ model, live, onClose, onAction, onChanged }: {
  model: LiveMaterialsModel; live: boolean; onClose?: () => void;
  onAction?: (body: Record<string, unknown>) => Promise<boolean>;
  onChanged?: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const run = onAction ?? model.action;
  const filtered = model.materials.filter((item) => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  useEffect(() => { if (adding) contentRef.current?.scrollTo({ top: 0 }); }, [adding]);
  useEffect(() => {
    if (!onClose) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <section aria-label="Materiales de la clase" className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900 text-slate-100">
      <input ref={inputRef} type="file" multiple accept={MATERIAL_ACCEPT} disabled={model.busy} className="hidden" onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (files.length) {
          setQuery("");
          contentRef.current?.scrollTo({ top: 0 });
          void model.upload(files).then((ok) => { if (ok) onChanged?.(); });
        }
      }} />
      <div className="shrink-0 border-b border-white/10 bg-slate-900 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Materiales <span className="text-sm font-normal text-slate-400">{model.materials.length}/50</span></h2>
        {onClose ? <button type="button" onClick={onClose} aria-label="Cerrar materiales" className="flex shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 text-xs font-semibold hover:bg-white/20"><X className="h-4 w-4" />Cerrar</button> : null}
      </div>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <button type="button" disabled={model.busy} onClick={() => inputRef.current?.click()} className="flex items-center justify-center gap-2 rounded-xl bg-sky-600 px-3 py-2.5 text-sm font-semibold hover:bg-sky-500 disabled:opacity-50"><Upload className="h-4 w-4" />Subir archivo</button>
        <button type="button" onClick={() => setAdding(!adding)} disabled={model.busy} aria-expanded={adding} className="flex items-center justify-center gap-1.5 rounded-xl bg-white/10 px-3 py-2.5 text-sm font-semibold hover:bg-white/20 disabled:opacity-50"><Link className="h-4 w-4" />YouTube</button>
      </div>
      </div>
      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-slate-400">Tus archivos y enlaces quedan guardados en esta clase. {live ? "Elige Presentar para mostrarlos a los alumnos." : "Podrás presentarlos al iniciar la clase."}</p>
        <p className="text-[11px] leading-relaxed text-slate-400">PDF e imágenes hasta 20 MB · Word .docx hasta 10 MB · PowerPoint .pptx hasta 50 MB · MP4/WebM hasta 200 MB. Usa PDF para conservar el diseño exacto de tus documentos.</p>
        {adding ? <div className="space-y-3 rounded-xl bg-slate-950/70 p-3">
          <form className="space-y-2" onSubmit={(event) => {
            event.preventDefault();
            void run({ action: "youtube", url, name }).then((ok) => { if (ok) { setUrl(""); setName(""); setAdding(false); } });
          }}>
            <label className="block text-xs font-medium" htmlFor="material-youtube-url">Enlace de YouTube</label>
            <input id="material-youtube-url" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.youtube.com/watch?v=…" className="w-full rounded-lg border border-slate-700 bg-slate-800 p-2 text-sm" />
            <input aria-label="Nombre del video (opcional)" value={name} maxLength={180} onChange={(event) => setName(event.target.value)} placeholder="Nombre del video (opcional)" className="w-full rounded-lg border border-slate-700 bg-slate-800 p-2 text-sm" />
            <button type="submit" disabled={model.busy || !parseYouTubeId(url)} className="w-full rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20 disabled:opacity-40">Agregar enlace</button>
          </form>
        </div> : null}
        {model.progress !== null ? <div role="status" className="space-y-2 text-xs text-sky-200">
          <p className="break-words">{model.uploadLabel}</p>
          <p>{model.progress === 100 ? "Preparando material…" : `Subiendo archivo… ${model.progress}%`}</p>
          <progress value={model.progress} max={100} className="h-2 w-full accent-sky-500" />
        </div> : null}
        {model.error || model.syncError ? <p role="alert" className="whitespace-pre-line rounded-lg bg-red-500/15 p-2 text-xs text-red-200">{model.error || model.syncError}</p> : null}
        <label className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2"><Search className="h-4 w-4 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Buscar materiales" placeholder="Buscar material" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
      </div>
      <div className="space-y-2 px-3 pb-4">
        {model.loading && !model.materials.length ? <p role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" />Cargando materiales…</p> : null}
        {!model.loading && !filtered.length ? <p className="px-4 py-8 text-center text-sm text-slate-400">{query ? "No se encontraron materiales." : "Usa Subir archivo o YouTube en la parte superior para preparar tus materiales."}</p> : null}
        {filtered.map((material) => {
          const active = model.activeMaterial?.id === material.id;
          return <div key={material.id} className={`rounded-xl border p-3 ${active ? "border-sky-500/60 bg-sky-500/10" : "border-white/5 bg-white/[0.03]"}`}>
            <div className="flex items-start gap-2.5"><MaterialIcon kind={material.kind} /><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{material.name}</p><p className="mt-1 text-xs text-slate-400">{MATERIAL_KIND_LABEL[material.kind]}{material.size ? ` · ${materialSize(material.size)}` : ""}</p></div></div>
            {deleteId === material.id ? <div className="mt-3 space-y-2"><p className="text-xs text-slate-300">¿Eliminar este material de la clase?</p><div className="flex gap-2"><button type="button" disabled={model.busy} onClick={() => { void run({ action: "delete", materialId: material.id }).then((ok) => { if (ok) setDeleteId(null); }); }} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs disabled:opacity-50">Eliminar</button><button type="button" onClick={() => setDeleteId(null)} className="rounded-lg bg-white/10 px-3 py-1.5 text-xs">Cancelar</button></div></div> : <div className="mt-3 flex items-center justify-between gap-2">
              <button type="button" disabled={model.busy || !live} onClick={() => { void run({ action: active ? "stop" : "present", materialId: material.id }); }} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-40 ${active ? "bg-sky-600 text-white" : "bg-white/10 hover:bg-white/20"}`}><Presentation className="h-3.5 w-3.5" />{active ? "Dejar de presentar" : "Presentar"}</button>
              <button type="button" disabled={model.busy} onClick={() => setDeleteId(material.id)} aria-label={`Eliminar ${material.name}`} className="rounded-lg p-2 text-slate-400 hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>}
          </div>;
        })}
      </div>
      </div>
    </section>
  );
}
