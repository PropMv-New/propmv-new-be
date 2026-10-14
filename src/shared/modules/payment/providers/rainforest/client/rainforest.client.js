'use strict';

const crypto = require('crypto');
const { createHttpClient } = require('../../../utils/httpClient.js.js');
const rainforestConfig = require('../../../../../../config/rainforest.config');
const logger = require('../../../../../../common/logger');
const { toUserFriendlyRainforestMessage } = require('../utils/rainforestUserError.util');

const RAINFOREST_ERRORS = {
  400: (msg) => msg || 'Invalid Rainforest request.',
  401: () => 'Rainforest authentication failed.',
  403: () => 'Rainforest permission denied.',
  404: () => 'Rainforest resource not found.',
  409: (msg) => msg || 'Rainforest resource already exists.',
  422: (msg) => msg || 'Rainforest validation failed.',
  429: () => 'Rainforest rate limit exceeded. Please retry shortly.',
  500: () => 'Rainforest service temporarily unavailable.',
};

class RainforestClient {
  constructor(options = {}) {
    const cfg = rainforestConfig.rainforest;
    this.apiKey = options.apiKey || cfg.apiKey;
    this.baseURL = options.baseURL || cfg.baseURL;
    this.timeout = options.timeout || cfg.timeoutMs;

    this.client = createHttpClient({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  }

  isConfigured() {
    return Boolean(this.apiKey && this.baseURL);
  }

  _idempotencyKey(prefix = 'rf') {
    return `${prefix}_${crypto.randomUUID()}`.slice(0, 64);
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
    return body.message || body.detail || fallback;
  }

  _parseError(err) {
    const status = err?.response?.status ?? err?.status ?? 500;
    const body = err?.response?.data ?? err?.data ?? {};
    const networkCode = err?.code || err?.cause?.code || '';
    if (!err?.response && networkCode) {
      const networkMessages = {
        ENOTFOUND: 'Rainforest API host could not be resolved. Check RAINFOREST_BASE_URL (expected api.sandbox.rainforestpay.com for sandbox).',
        ECONNREFUSED: 'Rainforest API connection refused. Verify RAINFOREST_BASE_URL and network access.',
        ETIMEDOUT: 'Rainforest API request timed out.',
        EAI_AGAIN: 'Rainforest API host lookup failed temporarily.',
      };
      return {
        status: 503,
        message: networkMessages[networkCode] || `Rainforest API unreachable (${networkCode || 'network error'}).`,
        raw: body,
      };
    }
    const detail = this._extractErrorMessage(body, err?.message || 'Rainforest request failed');
    const handler = RAINFOREST_ERRORS[status];
    const friendly = toUserFriendlyRainforestMessage(status, handler ? detail : detail);
    return {
      status,
      message: handler ? toUserFriendlyRainforestMessage(status, detail) : friendly,
      raw: body,
    };
  }

  async _request({ method, path, body, params, idempotencyKey, headers = {} }) {
    if (!this.isConfigured()) {
      const err = new Error('Rainforest is not configured.');
      err.statusCode = 503;
      throw err;
    }

    const config = {
      headers: {
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...headers,
      },
      ...(params ? { params } : {}),
    };

    try {
      const methodLower = String(method).toLowerCase();
      const res =
        methodLower === 'get' || methodLower === 'delete' || methodLower === 'head'
          ? await this.client[methodLower](path, config)
          : await this.client[methodLower](path, body ?? {}, config);
      return this._unwrap(res.data);
    } catch (err) {
      const parsed = this._parseError(err);
      logger.warn('[RainforestClient] Request failed', { path, status: parsed.status, message: parsed.message });
      const error = new Error(parsed.message);
      error.statusCode = parsed.status;
      error.rainforestError = parsed.raw;
      throw error;
    }
  }

  createMerchant(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/v1/merchants',
      body: payload,
      idempotencyKey: idempotencyKey || this._idempotencyKey('merchant'),
    });
  }

  getMerchant(merchantId) {
    return this._request({ method: 'get', path: `/v1/merchants/${encodeURIComponent(merchantId)}` });
  }

  patchMerchantApplication(merchantId, merchantApplicationId, payload) {
    return this._request({
      method: 'patch',
      path: `/v1/merchants/${encodeURIComponent(merchantId)}/applications/${encodeURIComponent(merchantApplicationId)}`,
      body: payload,
    });
  }

  createDepositMethodConfig(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/v1/deposit_method_configs',
      body: payload,
      idempotencyKey: idempotencyKey || this._idempotencyKey('dmcfg'),
    });
  }

  getDepositMethod(depositMethodId) {
    return this._request({
      method: 'get',
      path: `/v1/deposit_methods/${encodeURIComponent(depositMethodId)}`,
    });
  }

  getMerchantApplication(merchantId, merchantApplicationId) {
    return this._request({
      method: 'get',
      path: `/v1/merchants/${encodeURIComponent(merchantId)}/applications/${encodeURIComponent(merchantApplicationId)}`,
    });
  }

  simulateMerchantApplication(merchantId, merchantApplicationId, payload = { status: 'COMPLETED' }) {
    return this._request({
      method: 'post',
      path: `/v1/merchants/${encodeURIComponent(merchantId)}/applications/${encodeURIComponent(merchantApplicationId)}/simulate`,
      body: payload,
    });
  }

  createSession(payload) {
    return this._request({ method: 'post', path: '/v1/sessions', body: payload });
  }

  createPaymentMethodConfig(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/v1/payment_method_configs',
      body: payload,
      idempotencyKey: idempotencyKey || this._idempotencyKey('pmcfg'),
    });
  }

  getPaymentMethod(paymentMethodId) {
    return this._request({ method: 'get', path: `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}` });
  }

  listPaymentMethods(params = {}) {
    return this._request({ method: 'get', path: '/v1/payment_methods', params });
  }

  createPayinConfig(payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: '/v1/payin_configs',
      body: payload,
      idempotencyKey: idempotencyKey || payload?.idempotency_key || this._idempotencyKey('paycfg'),
    });
  }

  createPaymentMethodPayin(paymentMethodId, payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}/payin`,
      body: payload,
      idempotencyKey: idempotencyKey || payload?.idempotency_key || this._idempotencyKey('payin'),
    });
  }

  getPayin(payinId) {
    return this._request({ method: 'get', path: `/v1/payins/${encodeURIComponent(payinId)}` });
  }

  voidOrRefundPayin(payinId, payload, { idempotencyKey } = {}) {
    return this._request({
      method: 'post',
      path: `/v1/payins/${encodeURIComponent(payinId)}/void_or_refund`,
      body: payload,
      idempotencyKey: idempotencyKey || payload?.idempotency_key || this._idempotencyKey('voidrefund'),
    });
  }

  getRefund(refundId) {
    return this._request({ method: 'get', path: `/v1/refunds/${encodeURIComponent(refundId)}` });
  }
}

module.exports = { RainforestClient };
