"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { TalkingHead } from "@met4citizen/talkinghead";
import {
  createTalkingHeadSpeechAdapter,
  type AvatarSpeechAdapter,
} from "../features/avatar/AvatarSpeechAdapter";

// A default rigged Ready Player Me GLB, self-hosted from /public instead of
// fetched from models.readyplayer.me at runtime — that CDN is blocked on
// some corporate networks (incl. this one), which otherwise breaks avatar
// loading entirely. Sourced from TalkingHead's own repo, CC BY-NC 4.0.
// Swappable per-persona later by passing a different url prop.
const DEFAULT_AVATAR_URL = "/avatars/brunette.glb";

// TalkingHead's own speakText() always POSTs to a Google Cloud Text-to-Speech
// REST endpoint, so we don't use it. Speech audio is generated locally by
// Kokoro (see features/tts) and played by useKokoroTTS; this component only
// renders the head and exposes an AvatarSpeechAdapter that lip-syncs the
// face to that audio via TalkingHead's low-level setValue() morph targets.

// We load @met4citizen/talkinghead dynamically rather than importing it at
// module scope: the library pulls in Three.js and touches `window` on
// construction, which breaks SSR/test environments if imported eagerly.
export const AvatarContainer = forwardRef<AvatarSpeechAdapter>(function AvatarContainer(_props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<TalkingHead | null>(null);
  const adapterRef = useRef<AvatarSpeechAdapter | null>(null);
  if (!adapterRef.current) {
    // Speech that arrives before the GLB has loaded still plays; the face
    // simply starts moving once headRef is populated.
    adapterRef.current = createTalkingHeadSpeechAdapter(() => headRef.current);
  }
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let disposed = false;

    async function init() {
      if (!containerRef.current) return;
      try {
        const { TalkingHead } = await import("@met4citizen/talkinghead");

        const head = new TalkingHead(containerRef.current, {
          lipsyncModules: ["en"],
          cameraView: "upper",
        });

        await head.showAvatar({
          url: DEFAULT_AVATAR_URL,
          body: "F",
          avatarMood: "neutral",
        });

        if (disposed) {
          head.stop();
          return;
        }
        headRef.current = head;
        setStatus("ready");
      } catch (err) {
        console.error("Failed to initialize TalkingHead avatar:", err);
        if (!disposed) {
          setErrorMessage(err instanceof Error ? err.message : "Unknown error");
          setStatus("error");
        }
      }
    }

    init();

    return () => {
      disposed = true;
      adapterRef.current?.cancel();
      headRef.current?.stop?.();
      headRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => adapterRef.current!, []);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[32px] bg-gradient-to-b from-[#1c1c1e] to-black">
      <div ref={containerRef} className="h-full w-full" />
      {status === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black text-white/60">
          <Loader2 className="h-7 w-7 animate-spin" />
          <p className="text-sm">Loading interviewer…</p>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black px-6 text-center text-white/70">
          <p className="text-sm font-medium text-red-400">Avatar failed to load</p>
          <p className="text-xs text-white/40">{errorMessage}</p>
          <p className="text-xs text-white/40">
            The interview will continue via captions and voice only.
          </p>
        </div>
      )}
    </div>
  );
});
