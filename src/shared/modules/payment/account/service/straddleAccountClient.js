'use strict';

const { ClockService, DateUtil } = require('../../../../../common/date');

const crypto = require('crypto');
const { createHttpClient } = require('../../utils/httpClient.js.js');
const AccountApiLog = require('../model/accountApiLog.model');
const logger = require('../../../../../common/logger');

const STRADDLE_ACCOUNT_ERRORS = {
  400: (msg) => msg || 'Invalid request data.',
  401: () => 'Straddle authentication failed.',
  403: () => 'Permission denied.',
  404: () => 'Account not found.',
  405: () => 'Straddle does not allow this HTTP method for this resource.',
  409: (msg) => msg || 'Account already exists for this entity.',
  422: (msg) => msg || 'Validation failed.',
  429: () => 'Too many requests. Please try again shortly.',
  500: () => 'Straddle service temporarily unavailable.',
};

class StraddleAccountClient {
  constructor() {
    this.client = createHttpClient({
      baseURL: process.env.STRADDLE_BASE_URL,
      timeout: Number(process.env.STRADDLE_TIMEOUT) || 15000,
      headers: {
        Authorization: `Bearer ${process.env.STRADDLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Straddle requires Idempotency-Key length between 10 and 40 characters.
   * UUID alone is 36 chars (valid). Prefix+UUID can exceed 40 and returns 400.
   */
  _idempotencyKey() {
    return crypto.randomUUID(); // 36 chars
  }

  _extractErrorMessage(body, fallback) {
    if (!body || typeof body !== 'object') return fallback;

    const errorObj = body.error || body.data?.error || {};
    const items = errorObj.items || body.items;
    if (Array.isArray(items) && items.length) {
      const parts = items
        .map((item) => item?.detail || item?.message || item?.name || null)
        .filter(Boolean);
      if (parts.length) return parts.join('; ');
    }

    if (Array.isArray(body.errors) && body.errors.length) {
      return body.errors.map((e) => e?.detail || e?.message || String(e)).join('; ');
    }

    return (
      errorObj.detail ||
      errorObj.message ||
      body.detail ||
      body.title ||
      body.message ||
      fallback
    );
  }

  _parseError(err) {
    // httpClient interceptor may throw a plain object { message, status, data }
    const status = err?.response?.status ?? err?.status ?? 500;
    const body = err?.response?.data ?? err?.data ?? {};
    const detail = this._extractErrorMessage(body, err?.message || 'Unknown error');
    const handler = STRADDLE_ACCOUNT_ERRORS[status];
    return {
      status,
      message: handler ? handler(detail) : detail,
      raw: body,
    };
  }

  async _call({ operation, method, path, body, params, headers = {}, entityType, entityId, straddleAccountId, createdBy, correlationId, requestId }) {
    const start = ClockService.nowEpoch();
    let httpStatus = null;
    let responseBody = null;
    let errorDetails = null;
    let success = false;

    try {
      const config = {
        headers: {
          'Idempotency-Key': this._idempotencyKey(),
          // Required for Embed multi-tenant calls (linked banks under a sub-account)
          ...(straddleAccountId ? { 'Straddle-Account-Id': straddleAccountId } : {}),
          ...(correlationId ? { 'X-Correlation-ID': correlationId } : {}),
          ...(requestId ? { 'X-Request-ID': requestId } : {}),
          ...headers,
        },
        ...(params ? { params } : {}),
      };

      const methodLower = String(method).toLowerCase();
      const res =
        methodLower === 'get' || methodLower === 'delete' || methodLower === 'head'
          ? await this.client[method](path, config)
          : await this.client[method](path, body ?? {}, config);
      httpStatus = res.status;
      responseBody = res.data;
      success = true;
      return res.data?.data ?? res.data;
    } catch (err) {
      const parsed = this._parseError(err);
      httpStatus = parsed.status;
      errorDetails = { message: parsed.message, raw: parsed.raw };
      const error = new Error(parsed.message);
      error.statusCode = parsed.status;
      error.straddleError = parsed.raw;
      throw error;
    } finally {
      const executionMs = ClockService.nowEpoch() - start;
      setImmediate(async () => {
        try {
          await AccountApiLog.create({
            operation, entityType, entityId, straddleAccountId,
            requestBody: body || (params ? { params } : null),
            responseBody,
            httpStatus,
            correlationId,
            requestId,
            executionMs,
            success,
            errorDetails,
            createdBy: createdBy || null,
          });
        } catch (logErr) {
          logger.warn('[AccountClient] Failed to write API log', { error: logErr.message });
        }
      });
    }
  }

  async createAccount(payload, ctx = {}) {
    return this._call({
      operation: 'createAccount',
      method: 'post',
      path: '/accounts',
      body: payload,
      ...ctx,
    });
  }

  async getAccount(straddleAccountId, ctx = {}) {
    return this._call({
      operation: 'getAccount',
      method: 'get',
      path: `/accounts/${straddleAccountId}`,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      createdBy: ctx.createdBy,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  async updateAccount(straddleAccountId, payload, ctx = {}) {
    return this._call({
      operation: 'updateAccount',
      method: 'put',
      path: `/accounts/${straddleAccountId}`,
      body: payload,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      createdBy: ctx.createdBy,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  // ── Linked Bank Accounts (Embed) ────────────────────────────────────────────

  async createLinkedBankAccount(payload, ctx = {}) {
    return this._call({
      operation: 'createLinkedBankAccount',
      method: 'post',
      path: '/linked_bank_accounts',
      body: payload,
      ...ctx,
    });
  }

  async listLinkedBankAccounts(straddleAccountId, ctx = {}) {
    return this._call({
      operation: 'listLinkedBankAccounts',
      method: 'get',
      path: '/linked_bank_accounts',
      params: { account_id: straddleAccountId },
      straddleAccountId,
      ...ctx,
    });
  }

  async getLinkedBankAccount(linkedBankAccountId, ctx = {}) {
    return this._call({
      operation: 'getLinkedBankAccount',
      method: 'get',
      path: `/linked_bank_accounts/${linkedBankAccountId}`,
      ...ctx,
    });
  }

  async cancelLinkedBankAccount(linkedBankAccountId, ctx = {}) {
    return this._call({
      operation: 'cancelLinkedBankAccount',
      method: 'patch',
      path: `/linked_bank_accounts/${linkedBankAccountId}/cancel`,
      body: {},
      ...ctx,
    });
  }

  /** PUT - only allowed by Straddle when status is created or onboarding */
  async updateLinkedBankAccount(linkedBankAccountId, payload, ctx = {}) {
    return this._call({
      operation: 'updateLinkedBankAccount',
      method: 'put',
      path: `/linked_bank_accounts/${linkedBankAccountId}`,
      body: payload,
      ...ctx,
    });
  }

  // ── Representatives (Embed) ───────────────────────────────────────────────

  async createRepresentative(payload, ctx = {}) {
    return this._call({
      operation: 'createRepresentative',
      method: 'post',
      path: '/representatives',
      body: payload,
      ...ctx,
    });
  }

  async updateRepresentative(representativeId, payload, ctx = {}) {
    return this._call({
      operation: 'updateRepresentative',
      method: 'put',
      path: `/representatives/${representativeId}`,
      body: payload,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      createdBy: ctx.createdBy,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  async getRepresentative(representativeId, ctx = {}) {
    return this._call({
      operation: 'getRepresentative',
      method: 'get',
      path: `/representatives/${representativeId}`,
      ...ctx,
    });
  }

  async listRepresentatives(straddleAccountId, ctx = {}) {
    return this._call({
      operation: 'listRepresentatives',
      method: 'get',
      path: '/representatives',
      params: { account_id: straddleAccountId },
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      createdBy: ctx.createdBy,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  // ── Account onboarding ──────────────────────────────────────────────────────

  async onboardAccount(straddleAccountId, payload, ctx = {}) {
    return this._call({
      operation: 'onboardAccount',
      method: 'post',
      path: `/accounts/${straddleAccountId}/onboard`,
      body: payload,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      createdBy: ctx.createdBy,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  /**
   * Straddle simulate query final_status: "onboarding" | "active" (lowercase).
   * @see https://docs.straddle.com/api-reference/accounts/simulate
   */
  _normalizeSimulateFinalStatus(value) {
    const raw = String(value ?? 'active').trim().toLowerCase();
    if (raw === 'active' || raw === 'onboarding') return raw;
    return 'active';
  }

  async simulateAccountOnboarding(straddleAccountId, { finalStatus = 'active' } = {}, ctx = {}) {
    const accountId = String(straddleAccountId || '').trim();
    if (!accountId) {
      const err = new Error('Straddle account_id is required for simulate.');
      err.statusCode = 400;
      throw err;
    }
    const params = {
      final_status: this._normalizeSimulateFinalStatus(finalStatus),
    };
    return this._call({
      operation: 'simulateAccountOnboarding',
      method: 'post',
      path: `/accounts/${accountId}/simulate`,
      params,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      createdBy: ctx.createdBy,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  /** Sandbox: step through onboarding → active (Straddle status transition simulation). */
  async simulateAccountOnboardingComplete(straddleAccountId, ctx = {}) {
    try {
      await this.simulateAccountOnboarding(straddleAccountId, { finalStatus: 'onboarding' }, ctx);
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      const skip =
        err.statusCode === 409 ||
        msg.includes('already') ||
        (msg.includes('invalid') && msg.includes('onboarding'));
      if (!skip) {
        logger.warn('[AccountClient] simulate onboarding step skipped', {
          straddleAccountId,
          error: err.message,
        });
      }
    }
    return this.simulateAccountOnboarding(straddleAccountId, { finalStatus: 'active' }, ctx);
  }

  async createCapabilityRequest(straddleAccountId, payload, ctx = {}) {
    return this._call({
      operation: 'createCapabilityRequest',
      method: 'post',
      path: `/accounts/${straddleAccountId}/capability_requests`,
      body: payload,
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      createdBy: ctx.createdBy,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}

module.exports = { StraddleAccountClient };
