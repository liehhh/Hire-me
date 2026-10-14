// Strict half-duplex turn-taking. Exactly one party "has the floor" at a
// time, and every move between states goes through `transition`, which
// rejects anything not in the table below. This is the single authority on
// whose turn it is — TTS, speech recognition and network code only ask it.

export type ConversationState =
  | "idle"
  | "preparing"
  | "ai_speaking"
  | "waiting_for_candidate"
  | "candidate_speaking"
  | "candidate_finished"
  | "processing_answer"
  | "ready_for_ai"
  | "finished"
  | "error";

const TRANSITIONS: Record<ConversationState, readonly ConversationState[]> = {
  idle: ["preparing", "finished"],
  preparing: ["ai_speaking", "error", "finished"],
  // Only after Kokoro's audio has completely ended.
  ai_speaking: ["waiting_for_candidate", "finished", "error"],
  waiting_for_candidate: ["candidate_speaking", "finished", "error"],
  candidate_speaking: ["candidate_finished", "finished", "error"],
  // Back to candidate_speaking when nothing usable was captured.
  candidate_finished: ["processing_answer", "candidate_speaking", "finished", "error"],
  processing_answer: ["ready_for_ai", "finished", "error"],
  ready_for_ai: ["ai_speaking", "finished", "error"],
  // Recovery: retry start, retry the same answer, retry the same speech, or
  // continue in text mode after a voice failure.
  error: ["preparing", "processing_answer", "ai_speaking", "waiting_for_candidate", "finished"],
  finished: [],
};

export function canTransition(from: ConversationState, to: ConversationState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States in which the candidate's microphone is used for the answer. */
export const LISTENING_STATES: readonly ConversationState[] = ["waiting_for_candidate", "candidate_speaking"];

export class ConversationMachine {
  private current: ConversationState = "idle";
  private readonly listeners = new Set<(s: ConversationState) => void>();

  constructor(private readonly onReject?: (from: ConversationState, to: ConversationState) => void) {}

  get state(): ConversationState {
    return this.current;
  }

  is(...states: ConversationState[]): boolean {
    return states.includes(this.current);
  }

  /** Moves to `to` if allowed; returns false (and changes nothing) otherwise. */
  transition(to: ConversationState): boolean {
    if (!canTransition(this.current, to)) {
      this.onReject?.(this.current, to);
      return false;
    }
    this.current = to;
    for (const l of this.listeners) l(to);
    return true;
  }

  subscribe(listener: (s: ConversationState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
