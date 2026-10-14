import { Router, type NextFunction, type Request, type Response } from "express";
import type { InterviewService } from "../interview/interviewService.js";
import {
  analyzeRequestSchema,
  finishRequestSchema,
  respondRequestSchema,
  startRequestSchema,
} from "../interview/inputSchemas.js";
import { errorBody, toAppError } from "./apiErrors.js";

type Handler = (req: Request) => Promise<unknown>;

const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
  handler(req)
    .then((body) => res.json(body))
    .catch(next);
};

export function interviewRouter(service: InterviewService) {
  const router = Router();

  router.post("/analyze", route((req) => service.analyze(analyzeRequestSchema.parse(req.body))));

  router.post("/start", route((req) => service.start(startRequestSchema.parse(req.body))));

  router.post("/respond", route((req) => service.respond(respondRequestSchema.parse(req.body))));

  router.post(
    "/finish",
    route(async (req) => ({ report: await service.finish(finishRequestSchema.parse(req.body)) }))
  );

  return router;
}

/** Maps every error to the shared ApiErrorBody shape. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const appErr = toAppError(err);
  if (appErr.retryAfterSeconds) res.setHeader("Retry-After", String(appErr.retryAfterSeconds));
  res.status(appErr.httpStatus).json(errorBody(appErr));
}
