import type { NextFunction, Request, Response } from "express";
import { AppError } from "./gemini/geminiErrors.js";

/**
 * Sliding-window counter. `tryAcquire` either records a hit and returns 0,
 * or returns how many ms until a slot frees up.
 */
export class SlidingWindowLimiter {
  private hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  tryAcquire(): number {
    if (this.limit <= 0) return 0;
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length < this.limit) {
      this.hits.push(t);
      return 0;
    }
    return this.hits[0] + this.windowMs - t;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AppError("CANCELLED", "The request was cancelled.", 499, true));
      },
      { once: true }
    );
  });

/**
 * Process-wide Gemini budget, kept below the free-tier limits so the app
 * throttles itself before Google does. Short waits are absorbed; long ones
 * are surfaced to the user as a retryable rate-limit error.
 */
export class GeminiBudget {
  private readonly perMinute: SlidingWindowLimiter;
  private readonly perDay: SlidingWindowLimiter;

  constructor(rpm: number, rpd: number, private readonly maxWaitMs = 15_000) {
    this.perMinute = new SlidingWindowLimiter(rpm, 60_000);
    this.perDay = new SlidingWindowLimiter(rpd, 24 * 60 * 60_000);
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const dayWait = this.perDay.tryAcquire();
      if (dayWait > 0) {
        throw new AppError(
          "RATE_LIMITED",
          "The daily Gemini request budget configured for this server is used up.",
          429,
          true,
          Math.ceil(dayWait / 1000)
        );
      }
      const wait = this.perMinute.tryAcquire();
      if (wait === 0) return;
      // The day slot was consumed but the minute one wasn't — that only
      // over-counts the daily budget by one per wait, which is acceptable.
      if (wait > this.maxWaitMs) {
        throw new AppError(
          "RATE_LIMITED",
          "Too many AI requests right now. Nothing was lost — retry when ready.",
          429,
          true,
          Math.ceil(wait / 1000)
        );
      }
      await sleep(wait + 50, signal);
    }
  }
}

/** Per-IP HTTP rate limit for the interview API. */
export function ipRateLimit(perMinute: number) {
  const limiters = new Map<string, SlidingWindowLimiter>();
  setInterval(() => limiters.clear(), 10 * 60_000).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    let limiter = limiters.get(key);
    if (!limiter) {
      limiter = new SlidingWindowLimiter(perMinute, 60_000);
      limiters.set(key, limiter);
    }
    const wait = limiter.tryAcquire();
    if (wait > 0) {
      const retryAfterSeconds = Math.ceil(wait / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Please slow down.",
          retryable: true,
          retryAfterSeconds,
        },
      });
      return;
    }
    next();
  };
}

export { sleep };
