// @met4citizen/talkinghead ships no type declarations; it's consumed
// dynamically (see AvatarContainer.tsx) and treated as `any` beyond this
// module boundary.
declare module "@met4citizen/talkinghead" {
  export class TalkingHead {
    constructor(container: HTMLElement, options?: Record<string, unknown>);
    showAvatar(options: Record<string, unknown>): Promise<void>;
    speakText(text: string, options?: Record<string, unknown>): void;
    /** Set a morph target (e.g. "viseme_aa") to a value over an optional transition time (ms). */
    setValue(morphTarget: string, value: number, transitionMs?: number | null): void;
    /** Normalizes text (numbers, symbols → words) using the given lipsync language module. */
    lipsyncPreProcessText(text: string, lang: string): string;
    /** Converts words to Oculus viseme names with relative times/durations. */
    lipsyncWordsToVisemes(
      words: string,
      lang: string
    ): { visemes: string[]; times: number[]; durations: number[] };
    stop(): void;
    isSpeaking: boolean;
  }
}
