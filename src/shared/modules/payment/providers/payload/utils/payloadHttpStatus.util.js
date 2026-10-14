'use strict';

/**
 * Map Payload upstream HTTP status to PropMv API status.
 * Never forward 401/403 from Payload as PropMv 401 - the SPA would log users out.
 */
function httpStatusForPayloadUpstreamError(upstreamStatus) {
  const status = Number(upstreamStatus) || 500;
  if (status === 401 || status === 403) return 502;
  if (status === 429) return 503;
  if (status >= 400 && status < 500) return 502;
  if (status >= 500) return 503;
  return 502;
}

module.exports = {
  httpStatusForPayloadUpstreamError,
};
