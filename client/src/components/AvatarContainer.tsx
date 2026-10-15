"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { breadcrumb } from "../lib/debugLog";
import { isMobileDevice } from "../lib/device";
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
// the server (see features/tts) and played by useSpeech; this component only
// renders the head and exposes an AvatarSpeechAdapter that lip-syncs the
// face to that audio via TalkingHead's low-level setValue() morph targets.

// We load @met4citizen/talkinghead dynamically rather than importing it at
// module scope: the library pulls in Three.js and touches `window` on
// construction, which breaks SSR/test environments if imported eagerly.
export interface AvatarContainerProps {
  /** Never load the avatar (diagnostic mode). */
  off?: boolean;
}

export const AvatarContainer = forwardRef<AvatarSpeechAdapter, AvatarContainerProps>(function AvatarContainer(
  { off = false },
  ref
) {
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
    if (off) return;
    let disposed = false;

    async function init() {
      if (!containerRef.current) return;
      try {
        breadcrumb("avatar: import talkinghead");
        const { TalkingHead } = await import("@met4citizen/talkinghead");

        const head = new TalkingHead(containerRef.current, {
          // The library would import() its lip-sync rules from a computed
          // path, which the production bundle can't resolve (every load threw
          // "Cannot find module './lipsync-en.mjs'"). Register them instead.
          lipsyncModules: [],
          cameraView: "upper",
          // The canvas is rendered at modelPixelRatio × devicePixelRatio (3x
          // on iPhones) with antialiasing; render phones at a lower density.
          ...(isMobileDevice() ? { modelPixelRatio: 0.6, modelFPS: 30 } : {}),
        });
        const { LipsyncEn } = await import("@met4citizen/talkinghead/modules/lipsync-en.mjs");
        head.lipsync.en = new LipsyncEn();

        breadcrumb("avatar: showAvatar start");
        await head.showAvatar({
          url: DEFAULT_AVATAR_URL,
          body: "F",
          avatarMood: "neutral",
        });

        if (disposed) {
          head.stop();
          return;
        }
        breadcrumb("avatar: ready");
        headRef.current = head;
        setStatus("ready");
      } catch (err) {
        breadcrumb(`avatar: init failed ${String(err)}`);
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
  }, [off]);

  useImperativeHandle(ref, () => adapterRef.current!, []);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[32px] bg-gradient-to-b from-[#1c1c1e] to-black">
      <div ref={containerRef} className="h-full w-full" />
      {off && (
        <div className="absolute inset-0 flex items-center justify-center bg-black px-6 text-center text-sm text-white/50">
          Avatar disabled (diagnostic mode)
        </div>
      )}
      {!off && status === "loading" && (
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
