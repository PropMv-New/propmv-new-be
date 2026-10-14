'use strict';

const { ClockService, DateUtil } = require('../../../../common/date');

/**
 * ------------------------------------------------------------------
 * File: straddle.service.js
 * Module: Payment Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * payment.controller
 * ------------------------------------------------------------------
 */
const { createHttpClient } = require('../utils/httpClient.js.js');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');

const STRADDLE_CONFIG = {
  baseURL: process.env.STRADDLE_BASE_URL,
  apiKey: process.env.STRADDLE_API_KEY,
  timeout: Number(process.env.STRADDLE_TIMEOUT) || 15000,
};

const httpsAgent = process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

/**
 * Straddle Customer + Paykey + Payments client.
 * SaaS platforms MUST pass Straddle-Account-Id for customers, paykeys, charges, payouts.
 * Docs: https://docs.straddle.com/guides/embed/api-headers
 */
class StraddleService {
  constructor() {
    this.client = createHttpClient({
      baseURL: STRADDLE_CONFIG.baseURL,
      timeout: STRADDLE_CONFIG.timeout,
      headers: {
        Authorization: `Bearer ${STRADDLE_CONFIG.apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  generateIdempotencyKey() {
    return crypto.randomUUID();
  }

  /** Straddle expects SSN as XXX-XX-XXXX */
  _formatSsn(ssn) {
    if (!ssn) return null;
    const d = String(ssn).replace(/\D/g, '');
    if (d.length !== 9) return String(ssn);
    return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  }

  /** Straddle expects EIN as XX-XXXXXXX */
  _formatEin(ein) {
    if (!ein) return null;
    const d = String(ein).replace(/\D/g, '');
    if (d.length !== 9) return String(ein);
    return `${d.slice(0, 2)}-${d.slice(2)}`;
  }

  /**
   * Build compliance_profile for individual OR business.
   * When dob/ssn are omitted (owner Bridge onboarding), skip compliance_profile entirely.
   * When either is present, both are required (Patriot Act KYC).
   */
  _buildComplianceProfile(payload) {
    const isIndividual = (payload.type || 'individual') === 'individual';
    const hasDob = !!payload.dob;
    const hasSsn = !!payload.ssn;

    // Owner lightweight create: no KYC fields → no compliance_profile
    if (!hasDob && !hasSsn && isIndividual && !payload.ein && !payload.legalBusinessName) {
      return null;
    }

    const profile = {};
    if (payload.dob) profile.dob = String(payload.dob).trim();
    if (payload.ssn) profile.ssn = this._formatSsn(payload.ssn);

    if (!isIndividual) {
      if (payload.ein)               profile.ein                 = this._formatEin(payload.ein);
      if (payload.legalBusinessName) profile.legal_business_name = payload.legalBusinessName;
      if (payload.website)           profile.website             = payload.website;
    }

    if ((profile.ssn && !profile.dob) || (profile.dob && !profile.ssn)) {
      const err = new Error('Both date of birth (dob) and SSN are required in compliance_profile.');
      err.status = 422;
      throw err;
    }

    return Object.keys(profile).length ? profile : null;
  }

  /** Build request headers; always scope to embedded account when provided. */
  _headers(straddleAccountId, { idempotent = false, extra = {} } = {}) {
    return {
      ...(idempotent ? { 'Idempotency-Key': this.generateIdempotencyKey() } : {}),
      ...(straddleAccountId ? { 'Straddle-Account-Id': straddleAccountId } : {}),
      ...extra,
    };
  }

  // ── Customers ───────────────────────────────────────────────────────────────

  /**
   * POST /v1/customers
   * https://docs.straddle.com/api-reference/customers/create
   */
  async createCustomer(payload, straddleAccountId) {
    const body = {
      name:        payload.name,
      email:       payload.email,
      phone:       payload.phone,
      type:        payload.type || 'individual',
      external_id: payload.externalId,
      device:      { ip_address: payload.ipAddress || '127.0.0.1' },
      metadata:    payload.metadata || {},
    };

    const compliance_profile = this._buildComplianceProfile(payload);
    if (compliance_profile) body.compliance_profile = compliance_profile;

    const addr = payload.address;
    if (addr?.line1?.trim()) {
      body.address = {
        address1: addr.line1.trim(),
        ...(addr.city?.trim()  && { city:  addr.city.trim() }),
        ...(addr.state?.trim() && { state: addr.state.trim().toUpperCase() }),
        ...(addr.zip?.trim()   && { zip:   addr.zip.trim() }),
      };
    }

    const { data } = await this.client.post('/customers', body, {
      headers: this._headers(straddleAccountId, { idempotent: true }),
    });
    return data.data;
  }

  /**
   * PUT /v1/customers/{id}
   * https://docs.straddle.com/api-reference/customers/update
   */
  async updateCustomer(straddleCustomerId, payload, straddleAccountId) {
    const body = {};
    if (payload.name)  body.name  = payload.name;
    if (payload.email) body.email = payload.email;
    if (payload.phone) body.phone = payload.phone;

    const compliance_profile = this._buildComplianceProfile({
      ...payload,
      type: payload.type || 'individual',
    });
    if (compliance_profile) body.compliance_profile = compliance_profile;

    const addr = payload.address;
    if (addr?.line1?.trim()) {
      body.address = {
        address1: addr.line1.trim(),
        ...(addr.city?.trim()  && { city:  addr.city.trim() }),
        ...(addr.state?.trim() && { state: addr.state.trim().toUpperCase() }),
        ...(addr.zip?.trim()   && { zip:   addr.zip.trim() }),
      };
    }
    if (payload.metadata) body.metadata = payload.metadata;

    const { data } = await this.client.put(`/customers/${straddleCustomerId}`, body, {
      headers: this._headers(straddleAccountId),
    });
    return data.data;
  }

  /**
   * GET /v1/customers/{id}
   * https://docs.straddle.com/api-reference/customers/retrieve
   */
  async getCustomer(straddleCustomerId, straddleAccountId) {
    const { data } = await this.client.get(`/customers/${straddleCustomerId}`, {
      headers: this._headers(straddleAccountId),
    });
    return data.data;
  }

  /**
   * GET /v1/customers
   * https://docs.straddle.com/api-reference/customers/search
   */
  async listCustomers(params = {}, straddleAccountId) {
    const { data } = await this.client.get('/customers', {
      params,
      headers: this._headers(straddleAccountId),
    });
    return data.data;
  }

  /**
   * DELETE /v1/customers/{id}
   * https://docs.straddle.com/api-reference/customers/delete
   */
  async deleteCustomer(straddleCustomerId, straddleAccountId) {
    const { data } = await this.client.delete(`/customers/${straddleCustomerId}`, {
      headers: this._headers(straddleAccountId),
    });
    return data?.data ?? data;
  }

  /**
   * GET /v1/customers/{id}/review
   * https://docs.straddle.com/api-reference/customers/review
   */
  async reviewCustomer(straddleCustomerId, straddleAccountId) {
    const { data } = await this.client.get(`/customers/${straddleCustomerId}/review`, {
      headers: this._headers(straddleAccountId),
    });
    return data.data;
  }

  /**
   * PATCH /v1/customers/{id}/decision
   * https://docs.straddle.com/api-reference/customers/decision
   */
  async decisionCustomer(straddleCustomerId, payload, straddleAccountId) {
    const { data } = await this.client.patch(`/customers/${straddleCustomerId}/decision`, payload, {
      headers: this._headers(straddleAccountId, { idempotent: true }),
    });
    return data.data;
  }

  /**
   * GET /v1/customers/{id}/unmask
   * https://docs.straddle.com/api-reference/customers/unmask
   * Must be enabled by Straddle - use sparingly.
   */
  async unmaskCustomer(straddleCustomerId, straddleAccountId) {
    const { data } = await this.client.get(`/customers/${straddleCustomerId}/unmask`, {
      headers: this._headers(straddleAccountId),
    });
    return data.data;
  }

  // ── Paykeys / Bridge ────────────────────────────────────────────────────────

  /**
   * POST /v1/bridge/bank_account - create paykey from manual bank details
   * https://docs.straddle.com/guides/bridge/overview
   */
  async createPaykey(payload, straddleAccountId) {
    const { data } = await this.client.post('/bridge/bank_account', {
      customer_id: payload.customerId,
      account_number: String(payload.accountNumber),
      routing_number: String(payload.routingNumber),
      account_type: payload.accountType || 'checking',
      holder_name: payload.holderName,
    }, {
      headers: this._headers(straddleAccountId, { idempotent: true }),
    });
    return data.data;
  }

  /**
   * GET /v1/paykeys/{id}
   * https://docs.straddle.com/api-reference/paykeys/retrieve
   */
  async getPaykey(paykeyId, straddleAccountId) {
    const { data } = await this.client.get(`/paykeys/${paykeyId}`, {
      headers: this._headers(straddleAccountId),
    });
    return data.data;
  }

  /**
   * PATCH /v1/paykeys/{id} - limited updates where supported
   */
  async updatePaykey(paykeyId, updates, straddleAccountId) {
    const { data } = await this.client.patch(`/paykeys/${paykeyId}`, updates, {
      headers: this._headers(straddleAccountId),
    });
    return data.data;
  }

  /**
   * PATCH /v1/paykeys/{id}/review - approve/reject paykeys in review
   * https://docs.straddle.com/api-reference/paykeys/review
   */
  async reviewPaykey(paykeyId, payload, straddleAccountId) {
    const { data } = await this.client.patch(`/paykeys/${paykeyId}/review`, payload, {
      headers: this._headers(straddleAccountId),
    });
    return data.data;
  }

  /**
   * POST /v1/bridge/initialize
   * Docs: https://docs.straddle.com/api-reference/bridge/session
   * Returns { bridge_token } for the Bridge widget. Always pass Straddle-Account-Id for SaaS.
   */
  async createBridgeSession(straddleCustomerId, straddleAccountId, options = {}) {
    const body = {
      customer_id: straddleCustomerId,
      ...(options.externalId ? { external_id: options.externalId } : {}),
      ...(options.config ? { config: options.config } : {}),
    };

    const { data } = await this.client.post('/bridge/initialize', body, {
      headers: this._headers(straddleAccountId, { idempotent: true }),
    });

    const tokenData = data?.data ?? data;
    // Normalize for callers that expect session_key
    return {
      ...tokenData,
      bridge_token: tokenData.bridge_token || tokenData.session_key,
      session_key: tokenData.bridge_token || tokenData.session_key,
    };
  }

  // ── Charges / Payouts (always need Straddle-Account-Id for SaaS) ────────────

  async createCharge(payload, straddleAccountId) {
    const paymentDate = payload.paymentDate
      ? DateUtil.toISO(payload.paymentDate).split('T')[0]
      : DateUtil.toISO(ClockService.now()).split('T')[0];

    const body = {
      amount: payload.amount,
      currency: 'USD',
      paykey: payload.paykeyId,
      description: payload.description || 'HOA payment',
      payment_date: paymentDate,
      consent_type: 'signed',
      config: { balance_check: 'disabled' },
      external_id: payload.externalId || this.generateIdempotencyKey(),
      device: { ip_address: payload.ipAddress || '127.0.0.1' },
      metadata: payload.metadata || {},
    };

    const { data } = await this.client.post('/charges', body, {
      headers: this._headers(straddleAccountId, { idempotent: true }),
    });
    return data.data;
  }

  async createPayout(payload, straddleAccountId) {
    const { data } = await this.client.post('/payouts', {
      amount: payload.amount,
      currency: 'usd',
      paykey: payload.paykeyId,
      description: payload.description,
    }, {
      headers: this._headers(straddleAccountId, { idempotent: true }),
    });
    return data.data;
  }

  async getCharge(chargeId, straddleAccountId) {
    const { data } = await this.client.get(`/charges/${chargeId}`, {
      headers: this._headers(straddleAccountId),
    });
    return data.data;
  }

  async listCharges(params = {}, straddleAccountId) {
    const { data } = await this.client.get('/charges', {
      params,
      headers: this._headers(straddleAccountId),
    });
    return data.data;
  }
}

module.exports = { StraddleService };
