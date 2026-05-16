/**
 * Custom API error classes and the Fastify error mapper.
 *
 * All errors flow through fastify.setErrorHandler() which calls mapError().
 * Gitsheets exception classes (GitsheetsError, ValidationError, etc.) are
 * caught here and mapped to the documented error envelope per
 * specs/api/conventions.md#error.
 */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import {
  ConfigError,
  GitsheetsError,
  IndexError,
  NotFoundError,
  PathTemplateError,
  RefError,
  TransactionError,
  ValidationError as GitsheetsValidationError,
} from 'gitsheets';
import { errorResponse } from './response.js';

// ---------------------------------------------------------------------------
// Custom error classes
// ---------------------------------------------------------------------------

/** Thrown by the rate-limit plugin when a client exceeds their cap. */
export class RateLimitedError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super('Rate limit exceeded');
    this.name = 'RateLimitedError';
    this.retryAfter = retryAfter;
  }
}

/** Thrown when a request fails our own validation (422). */
export class ApiValidationError extends Error {
  readonly fields?: Record<string, string>;
  constructor(message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiValidationError';
    this.fields = fields;
  }
}

/** Thrown when the caller is not authenticated (401). */
export class UnauthenticatedError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/** Thrown when the caller is authenticated but not authorized (403). */
export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Thrown when a resource is not found (404). */
export class ApiNotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'ApiNotFoundError';
  }
}

/** Thrown on unique-constraint / slug conflicts (409). */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

// ---------------------------------------------------------------------------
// Error mapper
// ---------------------------------------------------------------------------

type TraceId = string | undefined;

/**
 * Map any thrown value to an HTTP status + error envelope.
 *
 * Called from fastify.setErrorHandler(). Never leaks internal error details
 * for 500s — only logs them with the traceId as the link.
 */
export function mapError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const traceId: TraceId = (req as FastifyRequest & { traceId?: string }).traceId;

  // --- Our own API errors ---

  if (err instanceof RateLimitedError) {
    void reply
      .code(429)
      .header('Retry-After', String(err.retryAfter))
      .send(errorResponse('rate_limited', 'Rate limit exceeded', traceId));
    return;
  }

  if (err instanceof ApiValidationError) {
    void reply
      .code(422)
      .send(errorResponse('validation_failed', err.message, traceId, err.fields));
    return;
  }

  if (err instanceof UnauthenticatedError) {
    void reply.code(401).send(errorResponse('unauthenticated', err.message, traceId));
    return;
  }

  if (err instanceof ForbiddenError) {
    void reply.code(403).send(errorResponse('forbidden', err.message, traceId));
    return;
  }

  if (err instanceof ApiNotFoundError) {
    void reply.code(404).send(errorResponse('not_found', err.message, traceId));
    return;
  }

  if (err instanceof ConflictError) {
    void reply.code(409).send(errorResponse('conflict', err.message, traceId));
    return;
  }

  // --- Gitsheets errors ---

  if (err instanceof NotFoundError) {
    void reply.code(404).send(errorResponse('not_found', 'Resource not found', traceId));
    return;
  }

  if (err instanceof GitsheetsValidationError) {
    void reply.code(422).send(errorResponse('validation_failed', err.message, traceId));
    return;
  }

  if (err instanceof TransactionError) {
    req.log.error({ err, traceId }, 'gitsheets transaction error');
    void reply.code(500).send(errorResponse('internal_error', 'An internal error occurred', traceId));
    return;
  }

  if (err instanceof IndexError || err instanceof RefError || err instanceof PathTemplateError) {
    req.log.error({ err, traceId }, 'gitsheets internal error');
    void reply.code(500).send(errorResponse('internal_error', 'An internal error occurred', traceId));
    return;
  }

  if (err instanceof ConfigError) {
    req.log.error({ err, traceId }, 'gitsheets config error');
    void reply.code(500).send(errorResponse('internal_error', 'An internal error occurred', traceId));
    return;
  }

  if (err instanceof GitsheetsError) {
    req.log.error({ err, traceId }, 'gitsheets error');
    void reply.code(500).send(errorResponse('internal_error', 'An internal error occurred', traceId));
    return;
  }

  // --- Fastify validation errors (schema-level, 400) ---

  const fastifyErr = err as FastifyError;
  if (fastifyErr.statusCode === 400 && fastifyErr.validation) {
    const fields: Record<string, string> = {};
    if (Array.isArray(fastifyErr.validation)) {
      for (const v of fastifyErr.validation) {
        const field = String((v as { instancePath?: string }).instancePath ?? 'unknown').replace(/^\//, '');
        fields[field || 'unknown'] = String((v as { message?: string }).message ?? 'invalid');
      }
    }
    void reply
      .code(422)
      .send(errorResponse('validation_failed', 'Validation failed', traceId, fields));
    return;
  }

  // --- Unknown / unhandled errors → 500, never leak details ---

  req.log.error({ err, traceId }, 'unhandled error');
  void reply.code(500).send(errorResponse('internal_error', 'An internal error occurred', traceId));
}
