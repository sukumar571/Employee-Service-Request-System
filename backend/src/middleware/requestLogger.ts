import type { RequestHandler } from 'express';
import type { Logger } from '../lib/logger.js';
import { getRequestContext } from './requestContext.js';

/** Mask the last octet(s) of client addresses in logs (docs/security-plan.md §5). */
export function maskIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  if (ip.includes(':')) {
    // IPv6: keep the /64 prefix only.
    const parts = ip.split(':');
    return `${parts.slice(0, 4).join(':')}:****`;
  }
  const octets = ip.split('.');
  const [first, second] = octets;
  if (octets.length !== 4 || !first || !second) return ip;
  return `${first}.${second}.***.***`;
}

/**
 * One structured line per request, excluding health probes which would dominate the log.
 * Duration comes from the request context so it matches the correlation id.
 */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    if (req.path.startsWith('/health')) {
      next();
      return;
    }

    res.on('finish', () => {
      const context = getRequestContext();
      const durationMs = context ? Date.now() - context.startedAtMs : undefined;
      logger.info(
        {
          request_id: context?.requestId,
          user_id: context?.userId,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          duration_ms: durationMs,
          ip: maskIp(req.ip),
          content_type: req.get('content-type') ?? undefined,
        },
        'request completed',
      );
    });

    next();
  };
}
