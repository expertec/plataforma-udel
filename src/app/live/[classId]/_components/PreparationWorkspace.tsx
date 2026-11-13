"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FolderOpen } from "lucide-react";
import { LiveMaterialsPanel, type LiveMaterialsModel } from "./LiveMaterialsPanel";

export function PreparationWorkspace({ model, children }: { model: LiveMaterialsModel; children: ReactNode }) {
  const [showMaterials, setShowMaterials] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Camera preparation and materials share one visible frame; only their contents scroll.
    window.scrollTo(0, 0);
    const viewport = window.visualViewport;
    const fitWorkspace = () => {
      const workspace = workspaceRef.current;
      if (!workspace) return;
      workspace.style.top = `${viewport?.offsetTop ?? 0}px`;
      workspace.style.left = `${viewport?.offsetLeft ?? 0}px`;
      workspace.style.width = `${viewport?.width ?? window.innerWidth}px`;
      workspace.style.height = `${viewport?.height ?? window.innerHeight}px`;
    };
    fitWorkspace();
    window.addEventListener("resize", fitWorkspace);
    viewport?.addEventListener("resize", fitWorkspace);
    viewport?.addEventListener("scroll", fitWorkspace);
    return () => {
      window.removeEventListener("resize", fitWorkspace);
      viewport?.removeEventListener("resize", fitWorkspace);
      viewport?.removeEventListener("scroll", fitWorkspace);
    };
  }, []);

  return <div ref={workspaceRef} className="fixed left-0 top-0 flex h-dvh w-full flex-col overflow-hidden bg-slate-950 text-white">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
      <span className="text-sm font-semibold">Preparar clase</span>
      <button type="button" aria-expanded={showMaterials} aria-controls="preparation-workspace-materials" onClick={() => setShowMaterials((open) => !open)} className="flex items-center gap-2 rounded-xl bg-sky-600 px-3 py-2 text-sm font-semibold hover:bg-sky-500">
        <FolderOpen className="h-4 w-4" />Materiales de la clase
      </button>
    </header>
    <div className="flex min-h-0 flex-1">
      <main aria-label="Preparación de cámara y micrófono" className={`min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain ${showMaterials ? "hidden lg:block" : ""}`}>
        {children}
      </main>
      {showMaterials ? <aside id="preparation-workspace-materials" aria-label="Biblioteca de materiales" className="h-full min-h-0 w-full shrink-0 p-3 lg:w-96 lg:border-l lg:border-white/10">
        <LiveMaterialsPanel model={model} live={false} onClose={() => setShowMaterials(false)} />
      </aside> : null}
    </div>
  </div>;
}
