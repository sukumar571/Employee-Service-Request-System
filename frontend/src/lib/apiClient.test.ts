import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, getResource, queryString, sendResource, toUserMessage } from './apiClient';
import { jsonResponse, stubFetch } from '../test/harness';

const payloadSchema = z.object({ id: z.string(), title: z.string() });

describe('apiClient', () => {
  it('unwraps the { data } envelope and validates it', async () => {
    const { calls } = stubFetch({
      '/api/v1/requests/7': jsonResponse(200, { data: { id: '7', title: 'VPN access' } }),
    });

    await expect(getResource('/requests/7', payloadSchema)).resolves.toEqual({
      id: '7',
      title: 'VPN access',
    });
    expect(calls).toEqual(['/api/v1/requests/7']);
  });

  it('rejects a response that does not match the shared schema', async () => {
    stubFetch({ '/api/v1/requests/8': jsonResponse(200, { data: { id: '8' } }) });

    await expect(getResource('/requests/8', payloadSchema)).rejects.toBeInstanceOf(Error);
  });

  it('turns an error envelope into a typed ApiError with the request id', async () => {
    stubFetch({
      '/api/v1/sla/policies/critical': jsonResponse(
        401,
        { error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } },
        'req-123',
      ),
    });

    const error = await sendResource(
      'PUT',
      '/sla/policies/critical',
      { first_response_minutes: 30, resolution_minutes: 240, reason: 'tighten response time' },
      payloadSchema,
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('UNAUTHENTICATED');
    expect(apiError.status).toBe(401);
    expect(apiError.requestId).toBe('req-123');
  });

  it('sends If-Match when an expected version is supplied', async () => {
    let sentIfMatch: string | undefined;
    const response = jsonResponse(200, { data: { id: '9', title: 'x' } });
    const spy = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      sentIfMatch = init?.headers?.['If-Match'];
      return response;
    });
    vi.stubGlobal('fetch', spy);

    await getResource('/requests/9', payloadSchema, { expectedVersion: 4 });

    expect(sentIfMatch).toBe('4');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('maps a network failure to SERVICE_UNAVAILABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const error = await getResource('/requests/1', payloadSchema).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('SERVICE_UNAVAILABLE');
    expect(toUserMessage(error)).toBe('Cannot reach the server. Check your connection.');
  });

  it('hides 5xx internals from users', () => {
    expect(toUserMessage(new ApiError('INTERNAL', 'connection string leaked', 500))).toBe(
      'The service could not complete the request.',
    );
    expect(toUserMessage(new Error('boom'))).toBe('Something went wrong while loading this page.');
  });

  it('builds query strings without empty noise', () => {
    expect(queryString({ status: 'open', page: 2, search: '' })).toBe('?status=open&page=2');
    expect(queryString({})).toBe('');
  });
});
