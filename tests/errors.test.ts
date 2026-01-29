import { describe, it, expect } from 'vitest';
import {
  IntegrationError,
  IntegrationAuthError,
  IntegrationRateLimitError,
  isIntegrationError,
  isToolErrorResponse,
  createToolError,
  toToolError,
  formatIntegrationError,
} from '../src/lib/errors.js';

describe('IntegrationError', () => {
  it('creates error with kind and message', () => {
    const error = new IntegrationError('auth', 'Authentication failed');

    expect(error.message).toBe('Authentication failed');
    expect(error.kind).toBe('auth');
    expect(error.name).toBe('IntegrationError');
  });

  it('includes optional properties', () => {
    const error = new IntegrationError('rate_limit', 'Too many requests', {
      integrationId: 'github',
      hint: 'Wait and retry',
      retryAfterSeconds: 60,
    });

    expect(error.integrationId).toBe('github');
    expect(error.hint).toBe('Wait and retry');
    expect(error.retryAfterSeconds).toBe(60);
  });

  it('preserves cause', () => {
    const cause = new Error('Original error');
    const error = new IntegrationError('upstream', 'Wrapped', { cause });

    expect(error.cause).toBe(cause);
  });
});

describe('IntegrationAuthError', () => {
  it('extends IntegrationError with auth kind', () => {
    const error = new IntegrationAuthError('Token expired');

    expect(error.kind).toBe('auth');
    expect(error.name).toBe('IntegrationAuthError');
    expect(error).toBeInstanceOf(IntegrationError);
  });
});

describe('IntegrationRateLimitError', () => {
  it('extends IntegrationError with rate_limit kind', () => {
    const error = new IntegrationRateLimitError('Rate limited');

    expect(error.kind).toBe('rate_limit');
    expect(error.name).toBe('IntegrationRateLimitError');
  });

  it('includes retryAt date', () => {
    const retryAt = new Date('2024-01-01T12:00:00Z');
    const error = new IntegrationRateLimitError('Rate limited', { retryAt });

    expect(error.retryAt).toEqual(retryAt);
  });
});

describe('isIntegrationError', () => {
  it('returns true for IntegrationError', () => {
    expect(isIntegrationError(new IntegrationError('auth', 'test'))).toBe(true);
  });

  it('returns true for subclasses', () => {
    expect(isIntegrationError(new IntegrationAuthError('test'))).toBe(true);
    expect(isIntegrationError(new IntegrationRateLimitError('test'))).toBe(true);
  });

  it('returns false for regular errors', () => {
    expect(isIntegrationError(new Error('test'))).toBe(false);
  });

  it('returns false for non-errors', () => {
    expect(isIntegrationError(null)).toBe(false);
    expect(isIntegrationError('error')).toBe(false);
    expect(isIntegrationError({ error: 'test' })).toBe(false);
  });
});

describe('isToolErrorResponse', () => {
  it('returns true for valid tool error response', () => {
    expect(isToolErrorResponse({ error: 'Something went wrong' })).toBe(true);
  });

  it('returns true with additional properties', () => {
    expect(
      isToolErrorResponse({
        error: 'Auth failed',
        errorType: 'auth',
        integrationId: 'github',
        hint: 'Re-authenticate',
      }),
    ).toBe(true);
  });

  it('returns false for non-objects', () => {
    expect(isToolErrorResponse(null)).toBe(false);
    expect(isToolErrorResponse('error')).toBe(false);
    expect(isToolErrorResponse(123)).toBe(false);
  });

  it('returns false for objects without error string', () => {
    expect(isToolErrorResponse({})).toBe(false);
    expect(isToolErrorResponse({ error: 123 })).toBe(false);
    expect(isToolErrorResponse({ message: 'test' })).toBe(false);
  });
});

describe('createToolError', () => {
  it('creates basic tool error', () => {
    const error = createToolError('github', 'API failed');

    expect(error).toEqual({
      error: 'API failed',
      errorType: undefined,
      integrationId: 'github',
      hint: undefined,
      retryAfterSeconds: undefined,
    });
  });

  it('includes optional fields', () => {
    const error = createToolError('salesforce', 'Rate limited', {
      kind: 'rate_limit',
      hint: 'Wait 60 seconds',
      retryAfterSeconds: 60,
    });

    expect(error.errorType).toBe('rate_limit');
    expect(error.hint).toBe('Wait 60 seconds');
    expect(error.retryAfterSeconds).toBe(60);
  });
});

describe('toToolError', () => {
  it('converts IntegrationError to tool error', () => {
    const error = new IntegrationAuthError('Token expired', {
      integrationId: 'github',
      hint: 'Re-authenticate',
    });

    const toolError = toToolError('fallback', error);

    expect(toolError.error).toBe('Token expired');
    expect(toolError.errorType).toBe('auth');
    expect(toolError.integrationId).toBe('github');
    expect(toolError.hint).toBe('Re-authenticate');
  });

  it('uses fallback integrationId when not in error', () => {
    const error = new IntegrationError('upstream', 'Server error');

    const toolError = toToolError('github', error);

    expect(toolError.integrationId).toBe('github');
  });

  it('converts regular Error', () => {
    const error = new Error('Something broke');

    const toolError = toToolError('github', error);

    expect(toolError.error).toBe('Something broke');
    expect(toolError.errorType).toBe('upstream');
    expect(toolError.integrationId).toBe('github');
  });

  it('converts string error', () => {
    const toolError = toToolError('github', 'Plain string error');

    expect(toolError.error).toBe('Plain string error');
    expect(toolError.errorType).toBe('upstream');
  });
});

describe('formatIntegrationError', () => {
  it('formats basic error', () => {
    const error = new IntegrationError('auth', 'Authentication failed');

    expect(formatIntegrationError(error)).toBe('Authentication failed');
  });

  it('includes retry info for rate limit', () => {
    const error = new IntegrationRateLimitError('Too many requests', {
      retryAfterSeconds: 30,
    });

    const formatted = formatIntegrationError(error);

    expect(formatted).toContain('Too many requests');
    expect(formatted).toContain('Try again in 30s');
  });

  it('includes hint when present', () => {
    const error = new IntegrationAuthError('Token expired', {
      hint: 'Run "oauth connect github" to re-authenticate',
    });

    const formatted = formatIntegrationError(error);

    expect(formatted).toContain('Token expired');
    expect(formatted).toContain('oauth connect github');
  });

  it('combines all parts', () => {
    const error = new IntegrationRateLimitError('Rate limited', {
      retryAfterSeconds: 60,
      hint: 'Consider upgrading your plan',
    });

    const formatted = formatIntegrationError(error);

    expect(formatted).toContain('Rate limited');
    expect(formatted).toContain('Try again in 60s');
    expect(formatted).toContain('Consider upgrading');
  });
});
