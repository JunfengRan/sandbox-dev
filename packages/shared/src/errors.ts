export interface PublicErrorCause {
  code?: string
  message: string
}

export interface PublicErrorBody {
  code: string
  message: string
  retryable: boolean
  ref: string
  causes?: PublicErrorCause[]
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly ref: string
  readonly causes?: PublicErrorCause[]

  constructor(input: {
    status: number
    code: string
    message: string
    retryable?: boolean
    ref?: string
    cause?: unknown
    causes?: PublicErrorCause[]
  }) {
    super(input.message)
    this.name = 'ApiError'
    this.status = input.status
    this.code = input.code
    this.retryable = input.retryable ?? input.status >= 500
    this.ref = input.ref ?? newErrorRef()
    this.causes = input.causes ?? (input.cause === undefined ? undefined : sanitizeCauseChain(input.cause))
  }
}

export function createApiError(
  status: number,
  code: string,
  message: string,
  retryable = status >= 500,
  cause?: unknown,
): ApiError {
  return new ApiError({ status, code, message, retryable, cause })
}

export function toPublicErrorBody(error: unknown): { status: number; body: PublicErrorBody } {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        code: error.code,
        message: error.status >= 500 ? 'Unexpected server error' : error.message,
        retryable: error.retryable,
        ref: error.ref,
        causes: error.status >= 500 ? undefined : error.causes,
      },
    }
  }

  const status =
    typeof error === 'object' && error && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 500
  const code =
    typeof error === 'object' && error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'INTERNAL.UNKNOWN'
  const message =
    typeof error === 'object' && error && 'message' in error && typeof error.message === 'string'
      ? error.message
      : 'Unexpected server error'
  const retryable =
    typeof error === 'object' && error && 'retryable' in error && typeof error.retryable === 'boolean'
      ? error.retryable
      : status >= 500
  const ref = newErrorRef()
  const causes = sanitizeCauseChain(error)

  return {
    status,
    body: {
      code,
      message: status >= 500 ? 'Unexpected server error' : message,
      retryable,
      ref,
      causes: status >= 500 ? undefined : causes,
    },
  }
}

export function newErrorRef() {
  return `err_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

const SECRET_PATTERN =
  /(password|passwd|secret|token|api[_-]?key|bearer|cookie)=([^\s;'"]+)/gi
const AUTHORIZATION_PATTERN = /(authorization)=([^\s;'"]+(?:\s+[^\s;'"]+)?)/gi
const BEARER_PATTERN = /\bBearer\s+[^\s;'"]+/gi
const MAX_CAUSE_DEPTH = 4

export function sanitizeCauseChain(error: unknown, depth = 0): PublicErrorCause[] | undefined {
  if (depth >= MAX_CAUSE_DEPTH || error == null) return undefined

  const current: PublicErrorCause = {
    code:
      typeof error === 'object' && error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined,
    message: redactSecrets(
      typeof error === 'object' && error && 'message' in error && typeof error.message === 'string'
        ? error.message
        : String(error),
    ),
  }

  const nested =
    typeof error === 'object' && error && 'cause' in error
      ? sanitizeCauseChain((error as { cause?: unknown }).cause, depth + 1)
      : undefined

  return nested ? [current, ...nested] : [current]
}

export function redactSecrets(value: string) {
  return value
    .replace(AUTHORIZATION_PATTERN, '$1=[REDACTED]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SECRET_PATTERN, '$1=[REDACTED]')
}
