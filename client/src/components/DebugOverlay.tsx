"use client";

import { useEffect, useState } from "react";
import { breadcrumb, clearBreadcrumbs, readBreadcrumbs } from "../lib/debugLog";

// On-device diagnostics for hard-to-reproduce mobile crashes. Breadcrumbs are
// always recorded; the panel only renders with ?debug=1 in the URL.
export function DebugOverlay() {
  const [visible, setVisible] = useState(false);
  const [previous, setPrevious] = useState<string[]>([]);

  useEffect(() => {
    const show = new URLSearchParams(location.search).get("debug") === "1";
    setVisible(show);
    // Read before this session adds its own entries: what the last session did.
    setPrevious(readBreadcrumbs());

    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    breadcrumb(
      `--- page load ua=${navigator.userAgent.slice(0, 80)} isolated=${String(self.crossOriginIsolated)} gpu=${String(
        "gpu" in navigator
      )} mem=${mem ? Math.round(mem.usedJSHeapSize / 1e6) + "MB" : "n/a"}`
    );

    const onError = (e: ErrorEvent) => breadcrumb(`window.error: ${e.message}`);
    const onRejection = (e: PromiseRejectionEvent) => breadcrumb(`unhandledrejection: ${String(e.reason)}`);
    const onPageHide = (e: PageTransitionEvent) => breadcrumb(`pagehide persisted=${e.persisted}`);
    const onVisibility = () => breadcrumb(`visibility=${document.visibilityState}`);
    const onFreeze = () => breadcrumb("page freeze");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("freeze", onFreeze);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("freeze", onFreeze);
    };
  }, []);

  if (!visible) return null;
  return (
    <details open className="fixed inset-x-0 bottom-0 z-[9999] max-h-[45dvh] overflow-auto bg-black/90 p-2 text-[10px] leading-tight text-green-400">
      <summary className="cursor-pointer">
        debug: previous session ({previous.length} entries){" "}
        <button
          className="ml-2 rounded bg-white/20 px-2 text-white"
          onClick={() => {
            clearBreadcrumbs();
            setPrevious([]);
          }}
        >
          clear
        </button>
      </summary>
      <pre className="whitespace-pre-wrap break-all">{previous.join("\n") || "(empty)"}</pre>
    </details>
  );
}
