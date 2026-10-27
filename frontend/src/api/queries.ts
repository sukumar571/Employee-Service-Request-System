import {
  apiCatalogSchema,
  commentSchema,
  createCommentBodySchema,
  livenessSchema,
  requestTimelineEntrySchema,
  slaPolicyDtoSchema,
  slaPolicyListSchema,
  systemStatusSchema,
  updateSlaPolicyBodySchema,
  type ApiCatalog,
  type CreateCommentBody,
  type Liveness,
  type RequestPriority,
  type SlaPolicyDto,
  type SystemStatus,
  type UpdateSlaPolicyBody,
} from '@esrs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getList, getResource, queryString, sendResource } from '../lib/apiClient';
import { HEALTH_POLL_MS, QUERY_STALE_MS } from '../lib/config';

/** Timeline page size. The contract caps one read at 200 entries, so the feed is always bounded. */
const TIMELINE_LIMIT = 100;

/**
 * Server state lives in TanStack Query (ADR-001): every hook names its query key, so a mutation
 * invalidates exactly the surfaces that changed. Response shapes are validated by the shared
 * schemas inside `apiClient`, so a backend contract change shows up here first.
 */
export const queryKeys = {
  liveness: ['health', 'live'] as const,
  readiness: ['health', 'ready'] as const,
  catalog: ['meta'] as const,
  slaPolicies: ['sla', 'policies'] as const,
  comments: (requestId: string, page: number) => ['requests', requestId, 'comments', page] as const,
  timeline: (requestId: string, limit: number) =>
    ['requests', requestId, 'timeline', limit] as const,
};

export function useLiveness() {
  return useQuery({
    queryKey: queryKeys.liveness,
    queryFn: ({ signal }) => getResource<Liveness>('/health/live', livenessSchema, { signal }),
    staleTime: QUERY_STALE_MS,
    refetchInterval: HEALTH_POLL_MS,
  });
}

export function useReadiness() {
  return useQuery({
    queryKey: queryKeys.readiness,
    queryFn: ({ signal }) =>
      getResource<SystemStatus>('/health/ready', systemStatusSchema, { signal }),
    staleTime: 5_000,
    refetchInterval: HEALTH_POLL_MS,
  });
}

export function useCatalog() {
  return useQuery({
    queryKey: queryKeys.catalog,
    queryFn: ({ signal }) => getResource<ApiCatalog>('/meta', apiCatalogSchema, { signal }),
    // The catalogue is a build-time contract: fetch once per session.
    staleTime: Infinity,
  });
}

export function useSlaPolicies() {
  return useQuery({
    queryKey: queryKeys.slaPolicies,
    queryFn: ({ signal }) =>
      getResource<SlaPolicyDto[]>('/sla/policies', slaPolicyListSchema, { signal }),
    staleTime: QUERY_STALE_MS,
  });
}

/**
 * Comment thread for one request, oldest-first.
 *
 * The API has already dropped the notes this caller may not see (`comment.read` scope plus the
 * `internal` visibility filter), so the component renders exactly what arrives and never re-filters.
 */
export function useRequestComments(requestId: string, page = 1) {
  return useQuery({
    queryKey: queryKeys.comments(requestId, page),
    queryFn: ({ signal }) =>
      getList(`/requests/${requestId}/comments${queryString({ page })}`, commentSchema, { signal }),
    staleTime: QUERY_STALE_MS,
  });
}

/** Activity feed (lifecycle events + the fact that a comment was added) — not the audit log. */
export function useRequestTimeline(requestId: string, limit = TIMELINE_LIMIT) {
  return useQuery({
    queryKey: queryKeys.timeline(requestId, limit),
    queryFn: ({ signal }) =>
      getList(
        `/requests/${requestId}/timeline${queryString({ limit })}`,
        requestTimelineEntrySchema,
        { signal },
      ),
    staleTime: QUERY_STALE_MS,
  });
}

/**
 * `POST /requests/{id}/comments`. A new comment changes two surfaces at once — the thread itself and
 * the `comment_added` marker inside the timeline — so both are invalidated under the same request key.
 */
export function useAddComment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { requestId: string; body: CreateCommentBody }) =>
      sendResource(
        'POST',
        `/requests/${input.requestId}/comments`,
        createCommentBodySchema.parse(input.body),
        commentSchema,
      ),
    onSuccess: (_comment, input) => {
      const root = ['requests', input.requestId] as const;
      void client.invalidateQueries({ queryKey: [...root, 'comments'] });
      void client.invalidateQueries({ queryKey: [...root, 'timeline'] });
    },
  });
}

/** Manager+ edit (ST-403); the payload schema is the same one the API parses. */
export function useUpdateSlaPolicy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { priority: RequestPriority; body: UpdateSlaPolicyBody }) =>
      sendResource(
        'PUT',
        `/sla/policies/${input.priority}`,
        updateSlaPolicyBodySchema.parse(input.body),
        slaPolicyDtoSchema,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.slaPolicies });
      void client.invalidateQueries({ queryKey: queryKeys.catalog });
    },
  });
}
