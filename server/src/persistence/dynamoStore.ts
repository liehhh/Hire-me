import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { InterviewSession } from "../interview/session.js";
import { AppError } from "../services/gemini/geminiErrors.js";
import { decodeSession, encodeSession } from "./sessionCodec.js";

/** The only DynamoDB surface used, so tests can pass a fake. */
export type DocClient = Pick<DynamoDBDocumentClient, "send">;

export interface LoadedSession {
  session: InterviewSession;
  /** Opaque optimistic-lock token to pass back to `save`. */
  version: number;
}

/**
 * Sessions and rate-limit counters share one table (partition key `pk`, TTL
 * attribute `expiresAt`), which keeps it inside the DynamoDB always-free tier.
 */
export class DynamoStore {
  constructor(
    private readonly db: DocClient,
    private readonly table: string,
    private readonly now: () => number = Date.now
  ) {}

  private epochSeconds(offsetMs = 0) {
    return Math.floor((this.now() + offsetMs) / 1000);
  }

  async load(sessionId: string): Promise<LoadedSession | undefined> {
    const out = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `S#${sessionId}` }, ConsistentRead: true }));
    if (!out.Item) return undefined;
    return { session: decodeSession(out.Item.data as Uint8Array), version: out.Item.v as number };
  }

  /**
   * Writes the session if nobody else wrote it since `expectedVersion`
   * (0 = must not exist yet). Returns the new version.
   */
  async save(session: InterviewSession, expectedVersion: number, ttlMs: number): Promise<number> {
    const version = expectedVersion + 1;
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `S#${session.sessionId}`, v: version, data: encodeSession(session), expiresAt: this.epochSeconds(ttlMs) },
          ConditionExpression: "attribute_not_exists(pk) OR v = :expected",
          ExpressionAttributeValues: { ":expected": expectedVersion },
        })
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException || (err as { name?: string })?.name === "ConditionalCheckFailedException") {
        throw new AppError("INTERNAL_ERROR", "This interview is busy with another request. Retry in a moment.", 409, true, 2);
      }
      throw err;
    }
    return version;
  }

  /**
   * Fixed-window counter shared by every Lambda instance. Adds `weight` to the
   * bucket and returns the new total.
   */
  async incrementCounter(key: string, windowSeconds: number, weight = 1): Promise<{ total: number; retryAfterSeconds: number }> {
    const nowSec = this.epochSeconds();
    const bucket = Math.floor(nowSec / windowSeconds);
    const out = await this.db.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: `RL#${key}#${bucket}` },
        UpdateExpression: "ADD hits :w SET expiresAt = :exp",
        ExpressionAttributeValues: { ":w": weight, ":exp": (bucket + 1) * windowSeconds + 60 },
        ReturnValues: "UPDATED_NEW",
      })
    );
    return { total: (out.Attributes?.hits as number) ?? weight, retryAfterSeconds: (bucket + 1) * windowSeconds - nowSec };
  }
}
