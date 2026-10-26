import {
  apiCatalogSchema,
  livenessSchema,
  slaPolicyDtoSchema,
  slaPolicyListSchema,
  systemStatusSchema,
  updateSlaPolicyBodySchema,
  type ApiCatalog,
  type Liveness,
  type RequestPriority,
  type SlaPolicyDto,
  type SystemStatus,
  type UpdateSlaPolicyBody,
} from '@esrs/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getResource, sendResource } from '../lib/apiClient';
import { HEALTH_POLL_MS, QUERY_STALE_MS } from '../lib/config';

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
