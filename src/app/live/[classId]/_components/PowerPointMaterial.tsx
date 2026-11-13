"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PptxParseResult, renderSlides } from "pptx-react-renderer";
import type DOMPurify from "dompurify";
import type { LiveMaterial } from "@/lib/live-classes/materials";

type LoadedPresentation = {
  deck: PptxParseResult;
  render: typeof renderSlides;
  purifier: typeof DOMPurify;
};

// The renderer uses HTML for the SmartArt text fallback. Escape that field before rendering.
function escapeFallbackText(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "textContent" && typeof entry === "string") {
      (value as Record<string, unknown>)[key] = entry.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    } else if (entry && typeof entry === "object") escapeFallbackText(entry);
  }
}

export function PowerPointMaterial({ material, page }: { material: LiveMaterial; page: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<LoadedPresentation | null>(null);
  const [box, setBox] = useState({ width: 800, height: 450 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: Math.max(1, entry.contentRect.width - 24), height: Math.max(1, entry.contentRect.height - 24) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    void (async () => {
      const [renderer, { default: purifier }, { default: JSZip }, response] = await Promise.all([
        import("pptx-react-renderer"), import("dompurify"), import("jszip"), fetch(material.url, { signal: controller.signal }),
      ]);
      if (!response.ok) throw new Error("No se pudo descargar la presentación.");
      const buffer = await response.arrayBuffer();
      const [deck, zip] = await Promise.all([renderer.parsePptx(buffer), JSZip.loadAsync(buffer)]);
      const parser = new DOMParser();
      const [presentationXml, relationsXml, contentTypesXml] = await Promise.all([
        zip.file("ppt/presentation.xml")!.async("string"),
        zip.file("ppt/_rels/presentation.xml.rels")!.async("string"),
        zip.file("[Content_Types].xml")!.async("string"),
      ]);
      const presentation = parser.parseFromString(presentationXml, "application/xml");
      const relations = parser.parseFromString(relationsXml, "application/xml");
      const contentTypes = parser.parseFromString(contentTypesXml, "application/xml");
      const paths = Array.from(contentTypes.getElementsByTagNameNS("*", "Override"))
        .filter((entry) => entry.getAttribute("ContentType")?.endsWith("presentationml.slide+xml"))
        .map((entry) => (entry.getAttribute("PartName") ?? "").replace(/^\//, ""))
        .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] ?? 0) - Number(b.match(/slide(\d+)/)?.[1] ?? 0));
      const byPath = new Map(paths.map((path, index) => [path, deck.slides[index]]));
      const byId = new Map(Array.from(relations.getElementsByTagNameNS("*", "Relationship"))
        .filter((entry) => entry.getAttribute("TargetMode") !== "External")
        .map((entry) => [entry.getAttribute("Id"), new URL(entry.getAttribute("Target") ?? "", "https://pptx.invalid/ppt/").pathname.slice(1)]));
      const ordered = Array.from(presentation.getElementsByTagNameNS("*", "sldId")).map((entry) => {
        const path = byId.get(entry.getAttribute("r:id"));
        const slide = path ? byPath.get(path) : undefined;
        if (!slide) throw new Error("No se pudo leer el orden de las diapositivas. Prueba exportar a PDF.");
        return slide;
      });
      deck.slides = ordered;
      if (!deck.slides.length || deck.slides.length > 300) throw new Error("La presentación debe contener entre 1 y 300 diapositivas.");
      escapeFallbackText(deck.slides);
      if (!disposed) setLoaded({ deck, render: renderer.renderSlides, purifier });
    })().catch((cause) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : "No se pudo abrir PowerPoint. Prueba exportarlo a PDF.");
    });
    return () => { disposed = true; controller.abort(); };
  }, [material.url]);

  useEffect(() => {
    const destination = slideRef.current;
    if (!loaded || !destination) return;
    const slide = loaded.deck.slides[page - 1];
    if (!slide) return;
    // Render one slide, not a scrollable deck, so everyone follows the teacher's page.
    const staging = document.implementation.createHTMLDocument("").createElement("div");
    const scale = Math.max(0.01, Math.min(box.width / slide.width, box.height / slide.height, 2));
    loaded.render([slide], { container: staging, scale, showSlideNumbers: false, theme: "light" });
    const wrapper = staging.firstElementChild as HTMLElement | null;
    if (wrapper) { wrapper.style.padding = "0"; wrapper.style.minHeight = "0"; wrapper.style.background = "transparent"; }
    const renderedSlide = staging.querySelector<HTMLElement>(".pptx-slide");
    if (renderedSlide) renderedSlide.style.margin = "0";
    const safeSlide = loaded.purifier.sanitize(staging.innerHTML, {
      RETURN_DOM_FRAGMENT: true,
      USE_PROFILES: { html: true, svg: true },
      FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["srcset"],
    });
    destination.replaceChildren(safeSlide);
    return () => destination.replaceChildren();
  }, [loaded, page, box]);

  return <>
    <div ref={containerRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-slate-800 p-3">
      {error ? <p role="alert" className="p-4 text-center text-sm text-red-200">{error}</p> : <>
        {!loaded ? <Loader2 aria-label="Cargando PowerPoint" className="h-6 w-6 animate-spin text-sky-300" /> : null}
        <div ref={slideRef} role="img" aria-label={`${material.name}, diapositiva ${page}`} className="shrink-0 text-slate-900" />
      </>}
    </div>
    <p className="shrink-0 bg-slate-900 px-3 py-1 text-center text-[11px] text-slate-400">Vista previa estática. Para conservar exactamente el diseño, exporta a PDF.</p>
  </>;
}
