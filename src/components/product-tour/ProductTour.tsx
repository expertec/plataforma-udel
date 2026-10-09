"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { CircleHelp } from "lucide-react";
import { driver, type DriveStep, type Side, type Alignment } from "driver.js";

type TourTarget = string | string[];

export type ProductTourStep = {
  target?: TourTarget;
  title: string;
  description: string;
  side?: Side;
  align?: Alignment;
};

type ProductTourProps = {
  tourId: string;
  steps: ProductTourStep[];
  autoStart?: boolean;
  className?: string;
  buttonLabel?: string;
};

const TOUR_STORAGE_VERSION = 2;

function isVisible(element: Element) {
  const rect = element.getBoundingClientRect();
  const styles = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && styles.visibility !== "hidden" && styles.display !== "none";
}

function resolveTarget(target?: TourTarget) {
  if (!target) return undefined;

  const selectors = Array.isArray(target) ? target : [target];
  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector));
    const visible = candidates.find(isVisible);
    if (visible) return visible;
  }

  return undefined;
}

function hasSeenTour(storageKey: string) {
  try {
    return window.localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

function markTourSeen(storageKey: string) {
  try {
    window.localStorage.setItem(storageKey, "true");
  } catch {
    // Some browsers can block localStorage; the tour should still work.
  }
}

export function ProductTour({
  tourId,
  steps,
  autoStart = true,
  className = "",
  buttonLabel = "Ver recorrido",
}: ProductTourProps) {
  const hasAutoStarted = useRef(false);
  const storageKey = useMemo(
    () => `udel:product-tour:${tourId}:v${TOUR_STORAGE_VERSION}:seen`,
    [tourId],
  );

  const startTour = useCallback(() => {
    const availableSteps = steps.filter((step) => !step.target || resolveTarget(step.target));
    if (availableSteps.length === 0) return false;

    const tourSteps: DriveStep[] = availableSteps.map((step) => ({
      element: step.target ? (() => resolveTarget(step.target) as Element) : undefined,
      popover: {
        title: step.title,
        description: step.description,
        side: step.side ?? "bottom",
        align: step.align ?? "center",
      },
    }));

    const instance = driver({
      steps: tourSteps,
      animate: true,
      allowClose: true,
      allowKeyboardControl: true,
      allowScroll: true,
      disableActiveInteraction: true,
      overlayColor: "#0b0708",
      overlayOpacity: 0.68,
      popoverClass: "udel-product-tour",
      showButtons: ["next", "previous", "close"],
      showProgress: true,
      progressText: "{{current}} de {{total}}",
      nextBtnText: "Siguiente",
      prevBtnText: "Anterior",
      doneBtnText: "Listo",
      closeBtnLabel: "Cerrar recorrido",
      stagePadding: 8,
      stageRadius: 12,
      onDestroyed: () => {
        markTourSeen(storageKey);
      },
    });

    instance.drive();
    return true;
  }, [steps, storageKey]);

  useEffect(() => {
    if (!autoStart || hasAutoStarted.current) return;
    if (hasSeenTour(storageKey)) return;

    let attempts = 0;
    let timer: number | undefined;

    const tryStart = () => {
      if (hasAutoStarted.current || hasSeenTour(storageKey)) return;
      attempts += 1;

      if (startTour()) {
        hasAutoStarted.current = true;
        return;
      }

      if (attempts < 24) {
        timer = window.setTimeout(tryStart, 500);
      }
    };

    timer = window.setTimeout(tryStart, 700);
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [autoStart, startTour, storageKey]);

  return (
    <button
      type="button"
      onClick={startTour}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-black/65 text-white shadow-xl backdrop-blur transition hover:bg-black/80 focus:outline-none focus:ring-2 focus:ring-white/40 ${className}`}
      aria-label={buttonLabel}
      title={buttonLabel}
    >
      <CircleHelp size={21} strokeWidth={2.2} />
    </button>
  );
}
