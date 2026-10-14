'use strict';

const crypto = require('crypto');
const { createHttpClient } = require('../../../utils/httpClient.js.js');
const payloadConfig = require('../../../../../../config/payload.config');
const logger = require('../../../../../../common/logger');
const { toUserFriendlyPayloadMessage } = require('../utils/payloadUserError.util');

const PAYLOAD_ERRORS = {
  400: (msg) => msg || 'Invalid Payload request.',
  401: () => 'Payload authentication failed.',
  403: () => 'Payload permission denied.',
  404: () => 'Payload resource not found.',
  409: (msg) => msg || 'Payload resource already exists.',
  422: (msg) => msg || 'Payload validation failed.',
  429: () => 'Payload rate limit exceeded. Please retry shortly.',
  500: () => 'Payload service temporarily unavailable.',
};

class PayloadClient {
  constructor(options = {}) {
    const cfg = payloadConfig.payload;
    this.apiKey = String(options.apiKey || cfg.apiKey || '').trim();
    this.baseURL = options.baseURL || cfg.baseURL;
    this.timeout = options.timeout || cfg.timeoutMs;
    this.apiVersion = options.apiVersion ?? cfg.apiVersion;

    this.client = createHttpClient({
      baseURL: this.baseURL,
      timeout: this.timeout,
      auth: {
        username: this.apiKey,
        password: '',
      },
      headers: {
        Accept: 'application/json',
        // Do not set Content-Type on GET - Payload returns 400 Bad Request otherwise.
        ...(this.apiVersion ? { 'Payload-Version': this.apiVersion } : {}),
      },
    });
  }

  isConfigured() {
    return Boolean(this.apiKey && this.baseURL);
  }

  _idempotencyKey(prefix = 'pl') {
    return `${prefix}_${crypto.randomUUID()}`.replace(/-/g, '').slice(0, 64);
  }

  _unwrap(body) {
    if (!body || typeof body !== 'object') return body;
    if (body.data !== undefined) return body.data;
    return body;
  }

  _extractErrorMessage(body, fallback) {
    if (!body || typeof body !== 'object') return fallback;
    if (Array.isArray(body.errors) && body.errors.length) {
      return body.errors.map((e) => e?.message || e?.detail || String(e)).join('; ');
    }
    const primary = body.error_description || body.message || body.error || body.detail || '';
    if (body.details && typeof body.details === 'object') {
      try {
        const { flattenPayloadErrorDetails } = require('../utils/payloadCheck21.util');
        const flat = flattenPayloadErrorDetails(body.details);
        if (flat) {
          return primary ? `${primary} (${flat})` : flat;
        }
      } catch {
        // optional helper — ignore if unavailable
      }
    }
    return primary || fallback;
  }

  _isMultipartBody(payloadBody) {
    if (!payloadBody || typeof payloadBody !== 'object') return false;
    if (typeof payloadBody.getHeaders === 'function' && typeof payloadBody.append === 'function') {
      return true;
    }
    if (typeof FormData !== 'undefined' && payloadBody instanceof FormData) {
      return true;
    }
    return false;
  }

  _parseError(err) {
    const status = err?.response?.status ?? err?.status ?? 500;
    const body = err?.response?.data ?? err?.data ?? err?.payloadError ?? {};
    const networkCode = err?.code || err?.cause?.code || '';
    if (!err?.response && !err?.data && networkCode) {
      return {
        status: 503,
        message: `Payload API unreachable (${networkCode || 'network error'}).`,
        raw: body,
      };
    }
    const detail = this._extractErrorMessage(body, err?.message || 'Payload request failed');
    const friendly = toUserFriendlyPayloadMessage(status, detail);
    return { status, message: friendly, raw: body };
  }

  async _request({ method, path, body, params, idempotencyKey, headers = {} }) {
    if (!this.isConfigured()) {
      const err = new Error('Payload is not configured.');
      err.statusCode = 503;
      throw err;
    }

    const methodLower = String(method).toLowerCase();
    const sendsBody = methodLower !== 'get' && methodLower !== 'delete' && methodLower !== 'head';

    const headerOverrides = headers && typeof headers === 'object' ? headers : {};
    const explicitContentType =
      headerOverrides['Content-Type'] || headerOverrides['content-type'] || '';
    const payloadBody = sendsBody ? (body ?? {}) : undefined;
    const useFormBody = sendsBody && typeof payloadBody === 'string';
    const useMultipart = sendsBody && this._isMultipartBody(payloadBody);

    const config = {
      headers: {
        ...(sendsBody && !explicitContentType && !useMultipart
          ? {
            'Content-Type': useFormBody ? 'application/x-www-form-urlencoded' : 'application/json',
          }
          : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...headerOverrides,
      },
      ...(params ? { params } : {}),
      ...(useMultipart
        ? { maxBodyLength: Infinity, maxContentLength: Infinity }
        : {}),
    };

    try {
      const res = sendsBody
        ? await this.client[methodLower](path, payloadBody, config)
        : await this.client[methodLower](path, config);
      return this._unwrap(res.data);
    } catch (err) {
      const parsed = this._parseError(err);
      logger.warn('[PayloadClient] Request failed', {
        path,
        status: parsed.status,
        message: parsed.message,
        errorType: parsed.raw?.error_type,
      });
      const error = new Error(parsed.message);
      error.statusCode = parsed.status;
      error.payloadError = parsed.raw;
      throw error;
    }
  }

  createProcessingAccount(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/processing_accounts/',
      body: payload,
      idempotencyKey: idempotencyKey || this._idempotencyKey('proc'),
    });
  }

  getProcessingAccount(processingId) {
    return this._request({
      method: 'get',
      path: `/processing_accounts/${encodeURIComponent(processingId)}`,
    });
  }

  updateProcessingAccount(processingId, payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'put',
      path: `/processing_accounts/${encodeURIComponent(processingId)}`,
      body: payload,
      idempotencyKey,
    });
  }

  listProcessingAccountPaymentMethods(processingId, params = {}) {
    return this._request({
      method: 'get',
      path: `/processing_accounts/${encodeURIComponent(processingId)}/payment_methods`,
      params,
    });
  }

  /**
   * Sandbox-only: request Payload test environment to mark a processing account active.
   * @see https://docs.payload.com/apis/api-design/ (PUT updates)
   */
  async simulateSandboxProcessingActivation(processingAccountId) {
    if (!payloadConfig.isPayloadSandbox()) {
      const err = new Error('Processing account activation simulation is only available in Payload sandbox.');
      err.statusCode = 400;
      throw err;
    }

    const id = String(processingAccountId || '').trim();
    const formBody = new URLSearchParams({ status: 'active' }).toString();
    let remote = null;

    try {
      remote = await this._request({
        method: 'put',
        path: `/processing_accounts/${encodeURIComponent(id)}`,
        body: formBody,
      });
    } catch (formErr) {
      logger.warn('[PayloadClient] Form activation update failed, retrying JSON', {
        processingAccountId: id,
        message: formErr.message,
      });
      remote = await this.updateProcessingAccount(id, { status: 'active' });
    }

    if (String(remote?.status || '').toLowerCase() === 'active') {
      return remote;
    }

    const refreshed = await this.getProcessingAccount(id);
    return refreshed || remote;
  }

  /** @deprecated Rainforest-shaped alias - Payload uses processing account activation. */
  simulateMerchantApplication(processingAccountId, _merchantApplicationId, payload = {}) {
    const status = payload?.status === 'COMPLETED' ? 'active' : (payload?.status || 'active');
    return this.updateProcessingAccount(processingAccountId, {
      status: String(status).toLowerCase() === 'completed' ? 'active' : String(status).toLowerCase(),
    });
  }

  createProcessingApplicationLink(processingId) {
    return this._request({
      method: 'post',
      path: `/processing_accounts/${encodeURIComponent(processingId)}/application_link`,
      body: {},
    });
  }

  createCustomer(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/customers/',
      body: payload,
      idempotencyKey: idempotencyKey || this._idempotencyKey('cust'),
    });
  }

  getCustomer(customerId) {
    return this._request({
      method: 'get',
      path: `/customers/${encodeURIComponent(customerId)}`,
    });
  }

  createPaymentMethod(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/payment_methods/',
      body: payload,
      idempotencyKey: idempotencyKey || this._idempotencyKey('pm'),
    });
  }

  getPaymentMethod(paymentMethodId) {
    return this._request({
      method: 'get',
      path: `/payment_methods/${encodeURIComponent(paymentMethodId)}`,
    });
  }

  updatePaymentMethod(paymentMethodId, payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'put',
      path: `/payment_methods/${encodeURIComponent(paymentMethodId)}`,
      body: payload,
      idempotencyKey,
    });
  }

  deletePaymentMethod(paymentMethodId) {
    return this._request({
      method: 'delete',
      path: `/payment_methods/${encodeURIComponent(paymentMethodId)}`,
    });
  }

  getDepositMethod(depositMethodId) {
    return this.getPaymentMethod(depositMethodId);
  }

  listPaymentMethods(params = {}) {
    return this._request({ method: 'get', path: '/payment_methods/', params });
  }

  createClientToken(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/access_tokens',
      body: payload,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  /**
   * Register + verify an Apple Pay on the Web domain for a processing account.
   * @see https://docs.payload.com/ui/mobile-wallets/activation/apple-pay-activation/
   * Host https://files.payload.com/applepay/apple-developer-merchantid-domain-association
   * at https://{domain}/.well-known/apple-developer-merchantid-domain-association before calling.
   */
  registerApplePayDomain({ profileId, domain }) {
    const profile_id = String(profileId || '').trim();
    const normalizedDomain = String(domain || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '');
    if (!profile_id || !normalizedDomain) {
      const err = new Error('profileId and domain are required for Apple Pay domain registration.');
      err.statusCode = 400;
      throw err;
    }
    const formBody = new URLSearchParams({
      profile_id,
      domain: normalizedDomain,
    }).toString();
    return this._request({
      method: 'post',
      path: '/applepay_domains',
      body: formBody,
    });
  }

  createPaymentTransaction(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/transactions/',
      body: payload,
      idempotencyKey: idempotencyKey || this._idempotencyKey('txn'),
    });
  }

  /**
   * Check21 remote deposit via multipart Transaction.create.
   * Live Payload API expects check_front[file] / check_back[file] + processing_id
   * (not docs-only check_images / receiver JSON fields).
   */
  createCheck21PaymentTransaction(form, { idempotencyKey } = {}) {
    if (!form || typeof form.getHeaders !== 'function') {
      const err = new Error('Check21 multipart form is required.');
      err.statusCode = 400;
      throw err;
    }
    const formHeaders = form.getHeaders();
    return this._request({
      method: 'post',
      path: '/transactions/',
      body: form,
      headers: formHeaders,
      idempotencyKey: idempotencyKey || this._idempotencyKey('chk21'),
    });
  }

  getTransaction(transactionId) {
    return this._request({
      method: 'get',
      path: `/transactions/${encodeURIComponent(transactionId)}`,
    });
  }

  updateTransaction(transactionId, payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'put',
      path: `/transactions/${encodeURIComponent(transactionId)}`,
      body: payload,
      idempotencyKey,
    });
  }

  voidTransaction(transactionId) {
    return this.updateTransaction(transactionId, { status: 'voided' });
  }

  createRefundTransaction(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/transactions/',
      body: { type: 'refund', ...payload },
      idempotencyKey: idempotencyKey || this._idempotencyKey('rfd'),
    });
  }

  createInvoice(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/invoices/',
      body: payload,
      idempotencyKey: idempotencyKey || this._idempotencyKey('inv'),
    });
  }

  updateInvoice(invoiceId, payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'put',
      path: `/invoices/${encodeURIComponent(invoiceId)}/`,
      body: payload,
      idempotencyKey,
    });
  }

  getInvoice(invoiceId) {
    return this._request({
      method: 'get',
      path: `/invoices/${encodeURIComponent(invoiceId)}/`,
    });
  }
}

module.exports = { PayloadClient };
