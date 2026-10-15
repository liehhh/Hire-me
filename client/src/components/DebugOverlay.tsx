"use client";

import { useEffect, useState } from "react";
import { SESSION_ID, breadcrumb, clearBreadcrumbs, readBreadcrumbs, startSessionTracking } from "../lib/debugLog";

// On-device diagnostics for hard-to-reproduce mobile crashes. Breadcrumbs and
// the session heartbeat are always recorded; the panel only renders with
// ?debug=1 in the URL.
export function DebugOverlay() {
  const [visible, setVisible] = useState(false);
  const [previous, setPrevious] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<string | null>(null);

  useEffect(() => {
    setVisible(new URLSearchParams(location.search).get("debug") === "1");
    // Read before this session adds its own entries: what the last session did.
    setPrevious(readBreadcrumbs());
    const previousVerdict = startSessionTracking();
    setVerdict(previousVerdict);

    breadcrumb(
      `--- page load ${location.pathname}${location.search} ua=${navigator.userAgent.slice(0, 60)} isolated=${String(
        self.crossOriginIsolated
      )} gpu=${String("gpu" in navigator)} cores=${navigator.hardwareConcurrency}`
    );
    if (previousVerdict) breadcrumb(`verdict: ${previousVerdict}`);

    const onError = (e: ErrorEvent) => breadcrumb(`window.error: ${e.message} @${e.filename}:${e.lineno}`);
    const onRejection = (e: PromiseRejectionEvent) => breadcrumb(`unhandledrejection: ${String(e.reason)}`);
    const onPageHide = (e: PageTransitionEvent) => breadcrumb(`pagehide persisted=${e.persisted}`);
    const onBeforeUnload = () => breadcrumb("beforeunload (navigation/reload requested by the page or user)");
    const onVisibility = () => breadcrumb(`visibility=${document.visibilityState}`);
    const onFreeze = () => breadcrumb("page freeze");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("freeze", onFreeze);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("freeze", onFreeze);
    };
  }, []);

  if (!visible) return null;
  return (
    <details open className="fixed inset-x-0 bottom-0 z-[9999] max-h-[45dvh] overflow-auto bg-black/90 p-2 text-[10px] leading-tight text-green-400">
      <summary className="cursor-pointer">
        debug {SESSION_ID}: previous log ({previous.length} entries){" "}
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
      {verdict && <p className="mb-1 font-bold text-yellow-300">{verdict}</p>}
      <pre className="whitespace-pre-wrap break-all">{previous.join("\n") || "(empty)"}</pre>
    </details>
  );
}
