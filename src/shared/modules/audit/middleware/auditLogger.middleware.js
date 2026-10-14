/**
 * ------------------------------------------------------------------
 * File: auditLogger.middleware.js
 * Module: Audit Logging Module
 *
 * Purpose:
 * Express middleware providing request timing, rate limiting, logging, or authentication filters.
 *
 * Used By:
 * app
 * ------------------------------------------------------------------
 */
const { createAuditLogInBackground } = require('../service/auditLog.service');
const { redactForAudit } = require('../utils/auditRedact.util');

/**
 * map Event From Method
 *
 * Performs logic operations for mapEventFromMethod.
 *
 * @param method - Request/input argument
 * @returns Operations result
 */
function mapEventFromMethod(method = '') {
  const upper = String(method).toUpperCase();
  if (upper === 'POST') return 'Create';
  if (upper === 'PUT') return 'Update';
  if (upper === 'PATCH') return 'Update';
  if (upper === 'DELETE') return 'Delete';
  return upper || 'Unknown';
}

/**
 * to Lower
 *
 * Performs logic operations for toLower.
 *
 * @param v - Request/input argument
 * @returns Operations result
 */
function toLower(v) {
  return String(v || '').toLowerCase();
}

/**
 * pick Response Message
 *
 * Performs logic operations for pickResponseMessage.
 *
 * @param afterPayload - Request/input argument
 * @returns Operations result
 */
function pickResponseMessage(afterPayload) {
  if (!afterPayload || typeof afterPayload !== 'object') return '';
  if (typeof afterPayload.message === 'string') return afterPayload.message;
  if (typeof afterPayload.msg === 'string') return afterPayload.msg;
  return '';
}

function inferPaymentEvent(method, path, afterPayload) {
  const upper = String(method).toUpperCase();

  if (path.includes('/billing-settings')) {
    if (upper === 'PUT') return 'BillingSettingsUpdated';
  }
  if (path.includes('/charges')) {
    if (upper === 'POST') return 'PaymentChargeCreated';
  }
  if (path.includes('/payouts')) {
    if (upper === 'POST') return 'PaymentPayoutCreated';
  }
  if (path.includes('/bank-accounts') || (path.includes('/banks') && path.includes('/accounts'))) {
    if (upper === 'POST') return 'BankAccountLinked';
    if (upper === 'PUT' || upper === 'PATCH') return 'BankAccountUpdated';
    if (upper === 'DELETE') return 'BankAccountRemoved';
  }
  if (path.includes('/customers')) {
    if (upper === 'POST') return 'PaymentCustomerCreated';
    if (upper === 'PUT') return 'PaymentCustomerUpdated';
    if (upper === 'DELETE') return 'PaymentCustomerRemoved';
  }
  if (path.includes('/owner/start-bank-link')) return 'OwnerBankLinkStarted';
  if (path.includes('/owner/complete-bank-link')) return 'OwnerBankLinkCompleted';
  if (path.includes('/bridge/session')) return 'BridgeSessionCreated';
  if (path.includes('/setup-intent')) return 'CardSetupIntentCreated';
  if (path.includes('/cards') && path.endsWith('/charge')) return 'CardChargeCreated';
  if (path.includes('/cards') && upper === 'DELETE') return 'CardRemoved';
  if (path.includes('/cards') && path.includes('/default')) return 'CardDefaultChanged';

  return null;
}

/**
 * infer Event From Payload
 *
 * Performs logic operations for inferEventFromPayload.
 *
 * @param method - Request/input argument
 * @param req - Request/input argument
 * @param afterPayload - Request/input argument
 * @returns Operations result
 */
function inferEventFromPayload(method, req, afterPayload) {
  const path = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase();
  const msg = toLower(pickResponseMessage(afterPayload));
  const body = (req && req.body && typeof req.body === 'object') ? req.body : {};

  // Explicit override from API/controller when needed.
  if (req && req.auditEvent && typeof req.auditEvent === 'string') {
    return req.auditEvent;
  }

  const paymentEvent = inferPaymentEvent(method, path, afterPayload);
  if (paymentEvent) return paymentEvent;

  // Message-based high-confidence mapping.
  if (msg.includes('comment added')) return 'CommentAdded';
  if (msg.includes('note added')) return 'NoteAdded';
  if (msg.includes('acknowledged')) return 'Acknowledged';
  if (msg.includes('approved')) return 'Approved';
  if (msg.includes('rejected')) return 'Rejected';
  if (msg.includes('terminated')) return 'Terminated';
  if (msg.includes('resolved')) return 'Resolved';
  if (msg.includes('reopened')) return 'Reopened';
  if (msg.includes('archived')) return 'Archived';
  if (msg.includes('unarchived')) return 'Unarchived';
  if (msg.includes('published')) return 'Published';
  if (msg.includes('draft')) return 'Drafted';
  if (msg.includes('activated')) return 'Activated';
  if (msg.includes('reminder')) return 'ReminderSent';
  if (msg.includes('uploaded')) return 'DocumentUploaded';
  if (msg.includes('billing settings saved')) return 'BillingSettingsUpdated';

  // Authenticated password change
  if (path.includes('/reset-password') && !path.includes('verify-otp')) {
    return 'PasswordChanged';
  }
  if (msg.includes('password updated') || msg.includes('password changed') || msg.includes('password reset successful')) {
    return 'PasswordChanged';
  }

  // Path/body-based mapping for non-standard response messages.
  if (path.includes('/comments')) {
    const txt = toLower(body.text || body.comment || body.content || '');
    if (txt.includes('reopened request') || txt.includes('re-opened request') || txt.includes('reopened')) return 'Reopened';
    if (txt.includes('marked as resolved') || txt.includes('resolved')) return 'Resolved';
    return 'CommentAdded';
  }
  if (path.includes('/notes')) return 'NoteAdded';
  if (path.includes('/approve')) return 'Approved';
  if (path.includes('/reject')) return 'Rejected';
  if (path.includes('/terminate')) return 'Terminated';
  if (path.includes('/resolve')) return 'Resolved';
  if (path.includes('/reopen')) return 'Reopened';
  if (path.includes('/archive')) return path.includes('/unarchive') ? 'Unarchived' : 'Archived';
  if (path.includes('/publish-from-inactive') || path.includes('/publish')) return 'Published';
  if (path.includes('/inactive') || path.includes('/draft')) return 'Drafted';
  if (path.includes('/activate')) return 'Activated';
  if (path.includes('/remind')) return 'ReminderSent';
  if (path.includes('/document') || path.includes('/documents') || path.includes('/images')) return 'DocumentUploaded';

  // Maintenance reopen via status transition.
  const statusRaw = body.status;
  if (typeof statusRaw === 'string') {
    const st = toLower(statusRaw);
    if (st === 'open') return 'Reopened';
    if (st === 'resolved') return 'Resolved';
    if (st === 'rejected') return 'Rejected';
    if (st === 'approved') return 'Approved';
  }

  // Fallback to method mapping.
  return mapEventFromMethod(method);
}

/**
 * resolve Actor Id
 *
 * Performs logic operations for resolveActorId.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function resolveActorId(req) {
  return req.userId || (req.user && (req.user._id || req.user.id)) || null;
}

/**
 * derive Module
 *
 * Performs logic operations for deriveModule.
 *
 * @param req - Request/input argument
 * @param sourceLabel - Request/input argument
 * @returns Operations result
 */
function deriveModule(req, sourceLabel = '') {
  const base = (req.baseUrl || '').replace(/^\/+|\/+$/g, '');
  if (!base) return sourceLabel || 'Unknown';
  const parts = base.split('/');
  if (parts.length === 0) return sourceLabel || 'Unknown';

  // For landlord routes, module usually follows /api/v1/landlord/<module>
  const landlordIdx = parts.indexOf('landlord');
  if (landlordIdx >= 0 && parts[landlordIdx + 1]) {
    const moduleName = parts[landlordIdx + 1];
    return moduleName.charAt(0).toUpperCase() + moduleName.slice(1);
  }

  const hoaIdx = parts.indexOf('hoa');
  if (hoaIdx >= 0 && parts[hoaIdx + 1]) {
    const moduleName = parts[hoaIdx + 1];
    return moduleName.charAt(0).toUpperCase() + moduleName.slice(1);
  }

  // For shared top-level routes, prefer meaningful segment (e.g. payments/cards)
  const fullPath = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase();
  if (fullPath.includes('/payments/cards')) return 'PaymentCards';
  if (fullPath.includes('/payments')) return 'Payments';
  if (fullPath.includes('/accounts')) return 'Accounts';

  const moduleName = parts[parts.length - 1];
  return moduleName ? moduleName.charAt(0).toUpperCase() + moduleName.slice(1) : (sourceLabel || 'Unknown');
}

/**
 * parse Response Body
 *
 * Performs logic operations for parseResponseBody.
 *
 * @param body - Request/input argument
 * @returns Operations result
 */
function parseResponseBody(body) {
  if (body == null) return null;
  if (typeof body === 'object') return body;
  if (Buffer.isBuffer(body)) return { payload: '<buffer>' };
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (_e) {
      return { payload: body };
    }
  }
  return { payload: String(body) };
}

function buildAfterSnapshot(method, req, afterPayload) {
  const upper = String(method).toUpperCase();
  const path = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase();

  // For billing settings updates, prefer normalized data from response over full envelope.
  if (path.includes('/billing-settings') && upper === 'PUT' && afterPayload?.data) {
    return afterPayload.data;
  }

  // For payment/card mutations, store structured summary when response wraps data.
  if (
    (path.includes('/payments') || path.includes('/cards'))
    && afterPayload?.data
    && (upper === 'POST' || upper === 'PUT' || upper === 'PATCH' || upper === 'DELETE')
  ) {
    const data = afterPayload.data;
    if (typeof data === 'object' && !Array.isArray(data)) {
      return data;
    }
  }

  return afterPayload;
}

/**
 * create Audit Logger Middleware
 *
 * Performs logic operations for createAuditLoggerMiddleware.
 *
 * @param options - Request/input argument
 * @returns Operations result
 */
function createAuditLoggerMiddleware({ sourceLabel = '' } = {}) {
  return function auditLoggerMiddleware(req, res, next) {
    const method = String(req.method || '').toUpperCase();
    if (method === 'GET') return next();

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let hasLogged = false;

    const logAudit = (afterPayload) => {
      if (hasLogged) return;
      hasLogged = true;

      const success = res.statusCode >= 200 && res.statusCode < 300;
      const responseMessage = pickResponseMessage(afterPayload);
      const event = inferEventFromPayload(method, req, afterPayload);
      const afterSnapshot = buildAfterSnapshot(method, req, afterPayload);

      createAuditLogInBackground({
        module: deriveModule(req, sourceLabel),
        event,
        action: event,
        entity: req.auditEntity || undefined,
        entityId: req.auditEntityId || undefined,
        createdBy: resolveActorId(req),
        before: req.auditBefore ?? null,
        after: redactForAudit(afterSnapshot ?? null),
        success,
        failureReason: success ? '' : (responseMessage || `HTTP ${res.statusCode}`),
        req,
        sourceLabel,
      });
    };

    res.json = function patchedJson(body) {
      logAudit(parseResponseBody(body));
      return originalJson(body);
    };

    res.send = function patchedSend(body) {
      logAudit(parseResponseBody(body));
      return originalSend(body);
    };

    return next();
  };
}

module.exports = {
  createAuditLoggerMiddleware,
};
