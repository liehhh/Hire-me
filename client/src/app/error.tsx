"use client";

import { useEffect } from "react";
import { breadcrumb } from "../lib/debugLog";

// Catches render errors so a crashing component shows a message instead of a
// blank page. It never navigates: the user keeps their place and chooses.
export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    breadcrumb(`react error boundary: ${error.message}`);
  }, [error]);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-semibold">Something went wrong.</h1>
      <p className="mt-4 max-w-md text-mute">{error.message}</p>
      <button onClick={reset} className="btn-primary mt-8">
        Try again
      </button>
    </main>
  );
}
