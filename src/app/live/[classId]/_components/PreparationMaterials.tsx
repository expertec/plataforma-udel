"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen } from "lucide-react";
import { LiveMaterialsPanel, type LiveMaterialsModel } from "./LiveMaterialsPanel";

export function PreparationMaterials({ model }: { model: LiveMaterialsModel }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const fitPanel = () => {
      const panel = panelRef.current;
      if (!panel) return;
      // Pin to the visible viewport, including zoom, scrolling and the mobile keyboard.
      panel.style.top = `${(viewport?.offsetTop ?? 0) + 16}px`;
      panel.style.height = `${Math.max(0, (viewport?.height ?? window.innerHeight) - 32)}px`;
      panel.style.right = `${Math.max(0, window.innerWidth - ((viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth))) + 16}px`;
      panel.style.maxWidth = `${Math.max(0, (viewport?.width ?? window.innerWidth) - 32)}px`;
    };
    fitPanel();
    viewport?.addEventListener("resize", fitPanel);
    viewport?.addEventListener("scroll", fitPanel);
    window.addEventListener("resize", fitPanel);
    return () => {
      viewport?.removeEventListener("resize", fitPanel);
      viewport?.removeEventListener("scroll", fitPanel);
      window.removeEventListener("resize", fitPanel);
    };
  }, [open]);

  return <>
    <button type="button" aria-expanded={open} aria-controls="preparation-materials" onClick={() => setOpen(!open)} className="fixed bottom-5 right-5 z-30 flex items-center gap-2 rounded-full bg-sky-600 px-5 py-3 text-sm font-semibold text-white shadow-xl hover:bg-sky-500">
      <FolderOpen className="h-5 w-5" />Materiales de la clase
    </button>
    {open ? createPortal(<div ref={panelRef} id="preparation-materials" className="fixed right-4 top-4 z-40 w-[min(24rem,calc(100vw-2rem))] shadow-2xl" style={{ height: "calc(100dvh - 2rem)" }}>
      <LiveMaterialsPanel model={model} live={false} onClose={() => setOpen(false)} />
    </div>, document.body) : null}
  </>;
}
