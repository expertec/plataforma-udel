"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { parseGoogleMaterialLink, type LiveMaterial } from "@/lib/live-classes/materials";

export function GoogleMaterial({ material }: { material: LiveMaterial }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const link = parseGoogleMaterialLink(material.url);
  if (!link?.embedUrl || link.kind !== material.kind) return <p role="alert" className="p-4 text-sm text-red-200">Este enlace de Google no es válido. Elimina el material y agrega el enlace original del archivo.</p>;

  return <>
    <div className="relative min-h-0 flex-1 overflow-hidden bg-white" style={{ flex: "1 1 0%", minHeight: 0, position: "relative", overflow: "hidden" }}>
      {loading && !failed ? <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-slate-950/60 text-white"><Loader2 aria-label={`Cargando ${link.label}`} className="h-6 w-6 animate-spin" /></div> : null}
      {failed ? <p role="alert" className="p-4 text-sm text-slate-900">No se pudo abrir el visor. Abre el archivo en Google y comprueba sus permisos.</p> : <iframe
        title={`${link.label}: ${material.name}`}
        src={link.embedUrl}
        style={{ display: "block", width: "100%", height: "100%", border: 0 }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
        onLoad={() => setLoading(false)}
        onError={() => { setLoading(false); setFailed(true); }}
      />}
    </div>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-white/10 bg-slate-900 px-3 py-2 text-xs text-slate-300">
      <p className="min-w-0 flex-1">Google conserva los permisos del archivo. La navegación dentro del visor es individual.</p>
      <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-2 font-semibold text-white hover:bg-white/20"><ExternalLink className="h-3.5 w-3.5" />Abrir en Google</a>
    </div>
  </>;
}
