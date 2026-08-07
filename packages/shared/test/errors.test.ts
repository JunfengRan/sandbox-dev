import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ApiError,
  createApiError,
  redactSecrets,
  sanitizeCauseChain,
  toPublicErrorBody,
} from '../src/errors.js'

test('redacts secret-bearing fragments from cause messages', () => {
  assert.equal(
    redactSecrets('OPENCODE_SERVER_PASSWORD=probe-secret Authorization=Bearer abc.def'),
    'OPENCODE_SERVER_PASSWORD=[REDACTED] Authorization=[REDACTED]',
  )
})

test('builds a bounded sanitized cause chain', () => {
  const leaf = Object.assign(new Error('token=super-secret'), { code: 'PROVIDER.AUTH_FAILED' })
  const mid = Object.assign(new Error('sandbox start failed'), { code: 'SANDBOX.START_FAILED', cause: leaf })
  const causes = sanitizeCauseChain(mid)

  assert.deepEqual(causes, [
    { code: 'SANDBOX.START_FAILED', message: 'sandbox start failed' },
    { code: 'PROVIDER.AUTH_FAILED', message: 'token=[REDACTED]' },
  ])
})

test('public 500 responses hide internals but keep a ref', () => {
  const error = createApiError(
    500,
    'SANDBOX.START_FAILED',
    'password=should-not-leak',
    true,
    new Error('Authorization=Bearer xyz'),
  )
  const publicError = toPublicErrorBody(error)

  assert.equal(publicError.status, 500)
  assert.equal(publicError.body.code, 'SANDBOX.START_FAILED')
  assert.equal(publicError.body.message, 'Unexpected server error')
  assert.equal(publicError.body.retryable, true)
  assert.match(publicError.body.ref, /^err_[a-f0-9]{12}$/)
  assert.equal(publicError.body.causes, undefined)
})

test('public 4xx responses keep actionable code and causes', () => {
  const error = new ApiError({
    status: 404,
    code: 'SANDBOX.LEASE_NOT_FOUND',
    message: 'Workspace lease not found',
    retryable: false,
    cause: Object.assign(new Error('missing lease'), { code: 'STATE.MISS' }),
  })
  const publicError = toPublicErrorBody(error)

  assert.equal(publicError.status, 404)
  assert.equal(publicError.body.code, 'SANDBOX.LEASE_NOT_FOUND')
  assert.equal(publicError.body.message, 'Workspace lease not found')
  assert.equal(publicError.body.retryable, false)
  assert.equal(publicError.body.ref, error.ref)
  assert.deepEqual(publicError.body.causes, [{ code: 'STATE.MISS', message: 'missing lease' }])
})
