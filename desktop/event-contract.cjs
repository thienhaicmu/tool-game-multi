const REQUEST_KINDS = new Set(['request', 'response', 'request-headers', 'replay', 'interaction']);

function normalizeCaptureEvent(event, sessionId) {
  if (!event || !REQUEST_KINDS.has(event.kind)) return null;
  return {
    schemaVersion: 1,
    sessionId,
    kind: String(event.kind),
    id: event.id ? String(event.id) : undefined,
    requestId: event.requestId ? String(event.requestId) : undefined,
    targetId: event.targetId ? String(event.targetId) : undefined,
    // Interaction (user click) fields + the link from a request to its click.
    text: event.text != null ? String(event.text) : undefined,
    selector: event.selector ? String(event.selector) : undefined,
    tag: event.tag ? String(event.tag) : undefined,
    causedBy: event.causedBy ? String(event.causedBy) : undefined,
    method: event.method ? String(event.method).toUpperCase() : undefined,
    url: event.url ? String(event.url) : undefined,
    resourceType: event.resourceType ? String(event.resourceType) : undefined,
    status: Number.isFinite(event.status) ? event.status : undefined,
    scope: event.scope ? String(event.scope) : undefined,
    overrides: Array.isArray(event.overrides) ? event.overrides.map(String) : undefined,
    timestamp: event.timestamp || new Date().toISOString(),
    duration: Number.isFinite(event.duration) ? event.duration : undefined,
    error: event.error ? String(event.error) : undefined,
    bodyPreview: event.bodyPreview,
    headers: event.headers,
  };
}

module.exports = { normalizeCaptureEvent };
