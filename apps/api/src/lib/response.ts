/**
 * Response envelope helpers.
 *
 * Every API endpoint returns one of these shapes per specs/api/conventions.md.
 * Routes import ok() or paginated() and return the result; the error shape is
 * produced by the error mapper in setErrorHandler.
 */

export interface ResponseMeta {
  readonly timestamp: string;
}

export interface PaginationMeta extends ResponseMeta {
  readonly page: number;
  readonly perPage: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface SuccessResponse<T> {
  readonly success: true;
  readonly data: T;
  readonly metadata: ResponseMeta;
}

export interface PaginatedResponse<T> {
  readonly success: true;
  readonly data: T[];
  readonly metadata: PaginationMeta;
}

export interface ErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly traceId?: string;
  readonly fields?: Record<string, string>;
}

export interface ErrorResponse {
  readonly success: false;
  readonly error: ErrorDetail;
  readonly metadata: ResponseMeta;
}

/** Wrap a single data value in the success envelope. */
export function ok<T>(data: T, meta?: Partial<ResponseMeta>): SuccessResponse<T> {
  return {
    success: true,
    data,
    metadata: {
      timestamp: meta?.timestamp ?? new Date().toISOString(),
    },
  };
}

/** Wrap a page of results in the paginated success envelope. */
export function paginated<T>(data: T[], pagination: Omit<PaginationMeta, 'timestamp'>): PaginatedResponse<T> {
  return {
    success: true,
    data,
    metadata: {
      timestamp: new Date().toISOString(),
      ...pagination,
    },
  };
}

/** Build the error envelope. Called by the error mapper. */
export function errorResponse(
  code: string,
  message: string,
  traceId?: string,
  fields?: Record<string, string>,
): ErrorResponse {
  const error: ErrorDetail = { code, message, ...(traceId ? { traceId } : {}), ...(fields ? { fields } : {}) };
  return {
    success: false,
    error,
    metadata: { timestamp: new Date().toISOString() },
  };
}
