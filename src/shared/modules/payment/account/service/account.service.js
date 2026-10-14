'use strict';

const { ClockService, DateUtil } = require('../../../../../common/date');

const mongoose = require('mongoose');
const StraddleAccount = require('../model/straddleAccount.model');
const { StraddleAccountClient } = require('./straddleAccountClient');
const { auditAccount, AUDIT_EVENTS } = require('./accountAudit.helper');
const {
  ACCOUNT_STATUS,
  ONBOARDING_STATUS,
  VERIFICATION_STATUS,
  CAPABILITY_STATUS,
  ENTITY_TYPE,
} = require('../constants/account.constants');
const { isHoaBoardAccount } = require('./accountAccess.helper');
const straddleConfig = require('../../../../../config/straddle.config');
const logger = require('../../../../../common/logger');

const client = new StraddleAccountClient();

/** Default Embed capabilities - single POST body per Straddle capability_requests API */
const DEFAULT_CAPABILITY_REQUEST_BODY = {
  charges: {
    enable: true,
    max_amount: 5000,
    daily_amount: 25000,
    monthly_count: 500,
    monthly_amount: 100000,
  },
  payouts: {
    enable: true,
    max_amount: 5000,
    daily_amount: 25000,
    monthly_count: 500,
    monthly_amount: 100000,
  },
  internet: {
    enable: true,
  },
};

const DEFAULT_CAPABILITY_TYPES = ['charges', 'payouts', 'internet'];

/** Default industry for property-management merchants (Landlord / HOA).
 *  Straddle validates MCC + Category + Sector as a fixed triad.
 *  Sending unsupported Category/Sector text returns 422.
 *  Per IndustryV1: if MCC is provided, category/sector are optional - prefer MCC-only.
 *  Docs examples that work: mcc "5734" (Software) or exact pairs like
 *  mcc "4457" + sector "Transportation and Facilities" + category "Boat Rentals and Leases".
 */
const DEFAULT_INDUSTRY = {
  mcc: '6513', // Real Estate Agents and Managers
};

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function buildIndustryPayload(industry) {
  const mcc = industry?.mcc || DEFAULT_INDUSTRY.mcc;
  const sector = industry?.sector?.trim();
  const category = industry?.category?.trim();

  // Only attach sector/category when both are provided (must be Straddle-supported pair).
  if (sector && category) {
    return { mcc, sector, category };
  }
  return { mcc };
}

function normalizeTaxId(taxId) {
  if (!taxId) return null;
  // Straddle Create Account OpenAPI: tax_id pattern ^[0-9]{9}$ (digits only, no hyphen)
  const digits = String(taxId).replace(/\D/g, '');
  return digits.length === 9 ? digits : String(taxId).replace(/\D/g, '') || null;
}

function normalizePhoneE164(phone) {
  if (!phone) return undefined;
  const trimmed = String(phone).trim();
  if (/^\+[1-9]\d{1,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return undefined;
}

function buildStraddleCreatePayload({
  accountName,
  legalName,
  email,
  phone,
  website,
  taxId,
  description,
  useCase,
  address,
  industry,
  supportEmail,
  supportPhone,
  supportUrl,
  externalId,
  metadata = {},
}) {
  const organizationId = straddleConfig.straddle.organizationId;
  if (!organizationId) {
    const err = new Error('Straddle organization is not configured on the server.');
    err.statusCode = 500;
    throw err;
  }

  const e164Phone = normalizePhoneE164(phone);
  const e164SupportPhone = normalizePhoneE164(supportPhone) || e164Phone;
  const taxIdDigits = normalizeTaxId(taxId);

  const payload = {
    organization_id: organizationId,
    account_type: 'business',
    business_profile: {
      name: accountName,
      legal_name: legalName || accountName,
      website,
      ...(taxIdDigits ? { tax_id: taxIdDigits } : {}),
      ...(e164Phone ? { phone: e164Phone } : {}),
      description: description || undefined,
      use_case: useCase || undefined,
      address: address
        ? {
            line1: address.line1,
            line2: address.line2 || undefined,
            city: address.city,
            state: address.state?.toUpperCase(),
            postal_code: address.zip,
            country: (address.country || 'US').toUpperCase(),
          }
        : undefined,
      industry: buildIndustryPayload(industry),
      support_channels: {
        email: supportEmail || email,
        ...(e164SupportPhone ? { phone: e164SupportPhone } : {}),
        url: supportUrl || website,
      },
    },
    access_level: 'standard',
    external_id: externalId,
  };

  // Only include metadata when non-empty (OpenAPI: map of string values)
  if (metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0) {
    payload.metadata = metadata;
  }

  return payload;
}

class AccountService {

  // ── Create ────────────────────────────────────────────────────────────────

  async createAccount({
    entityType,
    entityId,
    businessId,
    accountName,
    legalName,
    accountType,
    email,
    phone,
    website,
    taxId,
    description,
    useCase,
    address,
    industry,
    supportEmail,
    supportPhone,
    supportUrl,
    metadata = {},
    createdBy,
    correlationId,
    requestId,
  }) {
    if (!businessId) {
      const err = new Error('A company association is required to create an account.');
      err.statusCode = 400;
      throw err;
    }
    if (!entityId) {
      const err = new Error('entityId is required.');
      err.statusCode = 400;
      throw err;
    }

    // Multiple business entities per user - uniqueness is enforced by externalId (Straddle + DB index).
    const isHoaBoard = isHoaBoardAccount(entityType);
    const businessEntityId = entityId || new mongoose.Types.ObjectId().toString();

    const externalId = isHoaBoard && metadata?.hoaId
      ? `${entityType}_${String(createdBy)}_${String(metadata.hoaId)}_${String(businessEntityId)}`
      : `${entityType}_${String(businessEntityId)}`;
    const ctx = { entityType, entityId: businessEntityId, createdBy, correlationId, requestId };

    const straddlePayload = buildStraddleCreatePayload({
      accountName,
      legalName,
      email,
      phone,
      website,
      taxId,
      description,
      useCase,
      address,
      industry,
      supportEmail,
      supportPhone,
      supportUrl,
      externalId,
      metadata,
    });

    // Call Straddle first - do NOT persist locally unless Straddle accepts the account.
    let straddleData;
    try {
      straddleData = await client.createAccount(straddlePayload, ctx);
    } catch (err) {
      logger.error('[AccountService] Straddle createAccount failed - not persisting local record', {
        entityId,
        entityType,
        statusCode: err.statusCode,
        error: err.message,
        straddleError: err.straddleError || null,
      });
      const fail = new Error(err.message || 'Failed to create account with Straddle.');
      fail.statusCode = err.statusCode || 502;
      fail.straddleError = err.straddleError || null;
      throw fail;
    }

    if (!straddleData?.id) {
      const fail = new Error('Straddle did not return an account id. Account was not saved.');
      fail.statusCode = 502;
      throw fail;
    }

    const record = await StraddleAccount.create({
      businessId,
      entityType,
      entityId: businessEntityId,
      externalId,
      accountName,
      legalName:          legalName || accountName,
      accountType:        accountType || 'business',
      email:              email || null,
      phone:              normalizePhoneE164(phone) || phone || null,
      website:            website || null,
      taxId:              normalizeTaxId(taxId),
      address:            address || null,
      description:        description || null,
      useCase:            useCase || null,
      status:             straddleData.status || ACCOUNT_STATUS.CREATED,
      onboardingStatus:   straddleData.onboarding_status || ONBOARDING_STATUS.NOT_STARTED,
      verificationStatus: straddleData.verification_status || VERIFICATION_STATUS.UNVERIFIED,
      capabilityStatus:   straddleData.capability_status || CAPABILITY_STATUS.INACTIVE,
      straddleAccountId:  straddleData.id,
      organizationId:     straddleData.organization_id || straddleConfig.straddle.organizationId || null,
      capabilities:       straddleData.capabilities || {},
      metadata,
      environment:        process.env.NODE_ENV || 'development',
      latestRequest:      straddlePayload,
      latestResponse:     straddleData,
      latestError:        null,
      correlationId,
      requestId,
      createdBy,
      onboardingWizardStep: 1,
    });

    auditAccount({
      event: AUDIT_EVENTS.ACCOUNT_CREATED,
      createdBy,
      before: null,
      after: { entityType, entityId, straddleAccountId: record.straddleAccountId, status: record.status },
    });

    logger.info('[AccountService] Account created', { entityId, entityType, recordId: record._id, straddleAccountId: record.straddleAccountId });
    return record;
  }

  // ── Get ───────────────────────────────────────────────────────────────────

  async getAccountByEntity(entityId, entityType, { createdBy } = {}) {
    const query = { entityId, entityType, isDeleted: { $ne: true } };
    if (createdBy) query.createdBy = createdBy;
    return StraddleAccount.findOne(query).lean();
  }

  async getAccountById(id) {
    return StraddleAccount.findOne({ _id: id, isDeleted: { $ne: true } }).lean();
  }

  async listAccounts({ businessId, entityType, createdBy, entityId, hoaId } = {}) {
    const query = { isDeleted: { $ne: true } };

    if (entityType === ENTITY_TYPE.HOA && hoaId) {
      const id = String(hoaId);
      query.entityType = ENTITY_TYPE.HOA;
      query.$or = [{ 'metadata.hoaId': id }, { entityId: id }];
    } else if (entityType === ENTITY_TYPE.HOA && createdBy) {
      query.entityType = ENTITY_TYPE.HOA;
      query.createdBy = createdBy;
    } else {
      if (businessId) {
        query.businessId = businessId;
      } else if (createdBy) {
        query.createdBy = createdBy;
      }
      if (entityType) query.entityType = entityType;
      if (entityId) query.entityId = entityId;
    }

    return StraddleAccount.find(query).sort({ createdAt: -1 }).lean();
  }

  // ── Sync from Straddle ────────────────────────────────────────────────────

  async syncAccount(recordId, { createdBy, correlationId, requestId } = {}) {
    const oid = toObjectId(recordId);
    if (!oid) throw Object.assign(new Error('Account record not found'), { statusCode: 404 });
    const record = await StraddleAccount.findById(oid);
    if (!record) throw Object.assign(new Error('Account record not found'), { statusCode: 404 });
    if (!record.straddleAccountId) throw Object.assign(new Error('No Straddle account ID on record'), { statusCode: 400 });

    const ctx = { entityType: record.entityType, entityId: record.entityId, straddleAccountId: record.straddleAccountId, createdBy, correlationId, requestId };
    const straddleData = await client.getAccount(record.straddleAccountId, ctx);

    const before = { status: record.status, onboardingStatus: record.onboardingStatus };

    record.status              = straddleData.status             || record.status;
    record.onboardingStatus    = straddleData.onboarding_status  || record.onboardingStatus;
    record.verificationStatus  = straddleData.verification_status|| record.verificationStatus;
    record.capabilityStatus    = straddleData.capability_status  || record.capabilityStatus;
    record.complianceStatus    = straddleData.compliance_status  || record.complianceStatus;
    record.capabilities        = straddleData.capabilities       || record.capabilities;
    record.organizationId      = straddleData.organization_id    || record.organizationId;
    record.latestResponse      = straddleData;
    record.lastSyncedAt        = ClockService.now();
    record.syncAttempts        = (record.syncAttempts || 0) + 1;
    record.updatedBy           = createdBy || null;

    await record.save();

    auditAccount({
      event: AUDIT_EVENTS.STATUS_CHANGED,
      createdBy,
      before,
      after: { status: record.status, onboardingStatus: record.onboardingStatus },
    });

    return record.toObject();
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateAccount(recordId, updates, { createdBy, correlationId, requestId } = {}) {
    const oid = toObjectId(recordId);
    if (!oid) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    const record = await StraddleAccount.findById(oid);
    if (!record) throw Object.assign(new Error('Account not found'), { statusCode: 404 });

    const before = record.toObject();
    const straddleId = record.straddleAccountId ? String(record.straddleAccountId).trim() : null;

    if (!straddleId) {
      const err = new Error(
        'This business is not linked to Straddle yet. Create the account again or contact support.'
      );
      err.statusCode = 400;
      throw err;
    }

    const businessProfile = {};
    if (updates.accountName) businessProfile.name = updates.accountName;
    if (updates.legalName) businessProfile.legal_name = updates.legalName;
    if (updates.phone) businessProfile.phone = normalizePhoneE164(updates.phone) || updates.phone;
    if (updates.website) businessProfile.website = updates.website;
    if (updates.description !== undefined) businessProfile.description = updates.description || undefined;
    if (updates.useCase !== undefined) businessProfile.use_case = updates.useCase || undefined;
    if (updates.address) {
      businessProfile.address = {
        line1: updates.address.line1,
        line2: updates.address.line2 || undefined,
        city: updates.address.city,
        state: updates.address.state?.toUpperCase(),
        postal_code: updates.address.zip,
        country: (updates.address.country || 'US').toUpperCase(),
      };
    }
    if (updates.email || updates.phone || updates.website) {
      const supportPhone = updates.phone
        ? normalizePhoneE164(updates.phone) || updates.phone
        : record.phone;
      businessProfile.support_channels = {
        email: updates.email || record.email,
        ...(supportPhone ? { phone: supportPhone } : {}),
        url: updates.website || record.website,
      };
    }

    const straddlePayload = {};
    if (Object.keys(businessProfile).length > 0) straddlePayload.business_profile = businessProfile;
    if (updates.metadata) straddlePayload.metadata = updates.metadata;

    if (Object.keys(straddlePayload).length > 0) {
      const ctx = {
        entityType: record.entityType,
        entityId: record.entityId,
        createdBy,
        correlationId,
        requestId,
      };
      logger.info('[AccountService] Straddle updateAccount', {
        recordId: record._id,
        straddleAccountId: straddleId,
        method: 'PUT',
        path: `/accounts/${straddleId}`,
      });
      try {
        const straddleData = await client.updateAccount(straddleId, straddlePayload, ctx);
        record.latestResponse = straddleData;
      } catch (err) {
        logger.error('[AccountService] Straddle updateAccount failed', {
          recordId: record._id,
          straddleAccountId: straddleId,
          statusCode: err.statusCode,
          error: err.message,
        });
        const fail = new Error(err.message || 'Failed to update business with Straddle.');
        fail.statusCode = err.statusCode || 502;
        throw fail;
      }
    }

    if (updates.accountName) record.accountName = updates.accountName;
    if (updates.legalName) record.legalName = updates.legalName;
    if (updates.email) record.email = updates.email;
    if (updates.phone) record.phone = normalizePhoneE164(updates.phone) || updates.phone;
    if (updates.website) record.website = updates.website;
    if (updates.description !== undefined) record.description = updates.description || null;
    if (updates.useCase !== undefined) record.useCase = updates.useCase || null;
    if (updates.address) record.address = updates.address;
    if (updates.metadata) record.metadata = { ...record.metadata, ...updates.metadata };
    record.updatedBy = createdBy || null;

    await record.save();

    auditAccount({
      event: AUDIT_EVENTS.ACCOUNT_UPDATED,
      createdBy,
      before,
      after: record.toObject(),
    });

    return record.toObject();
  }

  // ── Delete (soft) ─────────────────────────────────────────────────────────

  async deleteAccount(recordId, { createdBy, req = null } = {}) {
    const oid = toObjectId(recordId);
    if (!oid) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    const record = await StraddleAccount.findById(oid);
    if (!record) throw Object.assign(new Error('Account not found'), { statusCode: 404 });

    const before = {
      recordId: String(record._id),
      entityType: record.entityType,
      entityId: record.entityId ? String(record.entityId) : '',
      status: record.status,
      straddleAccountId: record.straddleAccountId || '',
    };

    record.isDeleted = true;
    record.deletedAt = ClockService.now();
    record.deletedBy = createdBy || null;
    await record.save();
    logger.info('[AccountService] Account soft-deleted', { recordId });

    auditAccount({
      event: AUDIT_EVENTS.ACCOUNT_DISABLED,
      createdBy,
      before,
      after: { recordId: String(record._id), isDeleted: true, deletedAt: record.deletedAt },
      req,
      entity: 'StraddleAccount',
      entityId: String(record._id),
    });
  }

  // ── Status transition (called by webhook processor) ───────────────────────

  async applyStatusFromWebhook(straddleAccountId, data, eventType) {
    const record = await StraddleAccount.findOne({ straddleAccountId });
    if (!record) {
      logger.warn('[AccountService] applyStatusFromWebhook: no record found', { straddleAccountId });
      return null;
    }

    const before = { status: record.status, onboardingStatus: record.onboardingStatus, capabilityStatus: record.capabilityStatus };

    if (data.status)              record.previousStatus     = record.status;
    if (data.status)              record.status             = data.status;
    if (data.onboarding_status)   record.onboardingStatus   = data.onboarding_status;
    if (data.verification_status) record.verificationStatus = data.verification_status;
    if (data.capability_status)   record.capabilityStatus   = data.capability_status;
    if (data.compliance_status)   record.complianceStatus   = data.compliance_status;
    if (data.capabilities)        record.capabilities       = data.capabilities;

    record.lastWebhookAt       = ClockService.now();
    record.lastStatusChangeAt  = ClockService.now();

    if (data.status === ACCOUNT_STATUS.ACTIVE && !record.activatedAt) {
      record.activatedAt = ClockService.now();
    }
    if (data.status === ACCOUNT_STATUS.SUSPENDED || data.status === ACCOUNT_STATUS.CLOSED) {
      record.disabledAt = ClockService.now();
    }
    if (data.onboarding_status === ONBOARDING_STATUS.COMPLETED && !record.onboardingCompletedAt) {
      record.onboardingCompletedAt = ClockService.now();
    }

    await record.save();

    auditAccount({
      event: AUDIT_EVENTS.STATUS_CHANGED,
      before,
      after: { status: record.status, onboardingStatus: record.onboardingStatus, capabilityStatus: record.capabilityStatus },
    });

    logger.info('[AccountService] Status applied from webhook', { straddleAccountId, eventType, newStatus: record.status });

    return record;
  }

  /**
   * Request standard charges/payouts/internet capabilities before onboarding submit.
   */
  async ensureDefaultCapabilityRequests(record, ctx = {}) {
    if (!record?.straddleAccountId) {
      throw Object.assign(new Error('Account is not registered with Straddle'), { statusCode: 400 });
    }

    const straddleId = record.straddleAccountId;
    const callCtx = {
      entityType: record.entityType,
      entityId: record.entityId,
      createdBy: ctx.createdBy,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    };

    try {
      const data = await client.createCapabilityRequest(straddleId, DEFAULT_CAPABILITY_REQUEST_BODY, callCtx);
      record.metadata = {
        ...(record.metadata || {}),
        capabilityRequestsAt: DateUtil.toISO(ClockService.now()),
        capabilityRequests: DEFAULT_CAPABILITY_TYPES,
        capabilityRequestResponse: data,
      };
      record.updatedBy = ctx.createdBy || record.updatedBy || null;
      await record.save();

      auditAccount({
        event: AUDIT_EVENTS.CAPABILITIES_CHANGED,
        createdBy: ctx.createdBy,
        before: null,
        after: { recordId: record._id, capabilities: DEFAULT_CAPABILITY_TYPES },
      });

      return DEFAULT_CAPABILITY_TYPES.map((type) => ({ type, success: true, data }));
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      const duplicate = err.statusCode === 409 || msg.includes('already') || msg.includes('exist');
      if (duplicate) {
        record.metadata = {
          ...(record.metadata || {}),
          capabilityRequestsAt: DateUtil.toISO(ClockService.now()),
          capabilityRequests: DEFAULT_CAPABILITY_TYPES,
        };
        record.updatedBy = ctx.createdBy || record.updatedBy || null;
        await record.save();
        return DEFAULT_CAPABILITY_TYPES.map((type) => ({ type, success: true, duplicate: true }));
      }
      logger.error('[AccountService] capability request failed', {
        straddleAccountId: straddleId,
        statusCode: err.statusCode,
        error: err.message,
      });
      const fail = new Error(
        'We could not enable required payment capabilities (charges, payouts, internet). Please try again.'
      );
      fail.statusCode = err.statusCode || 502;
      throw fail;
    }
  }

  async updateOnboardingWizardStep(recordId, step, { createdBy } = {}) {
    const oid = toObjectId(recordId);
    if (!oid) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    const record = await StraddleAccount.findById(oid);
    if (!record || record.isDeleted) {
      throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    }
    const next = Math.min(5, Math.max(1, Number(step) || 1));
    record.onboardingWizardStep = Math.max(record.onboardingWizardStep || 1, next);
    record.updatedBy = createdBy || null;
    await record.save();
    return record.toObject();
  }

  /** Persist step 1 business fields + advance wizard step (local + Straddle when linked). */
  async saveBusinessOnboardingStep(recordId, updates, { createdBy, correlationId, requestId } = {}) {
    await this.updateAccount(recordId, updates, { createdBy, correlationId, requestId });
    return this.updateOnboardingWizardStep(recordId, 2, { createdBy });
  }

  /**
   * Submit Straddle onboard API with terms captured server-side (IP / user-agent).
   */
  async submitOnboarding(recordId, { acceptedUserAgent, agreementUrl }, reqMeta = {}) {
    const oid = toObjectId(recordId);
    if (!oid) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    const record = await StraddleAccount.findById(oid);
    if (!record || record.isDeleted) {
      throw Object.assign(new Error('Account not found'), { statusCode: 404 });
    }
    if (!record.straddleAccountId) {
      throw Object.assign(new Error('Account is not registered with Straddle'), { statusCode: 400 });
    }

    const acceptedAt = ClockService.now();
    const payload = {
      terms_of_service: {
        accepted_date: acceptedAt.toISOString(),
        accepted_ip: reqMeta.clientIp || '0.0.0.0',
        accepted_user_agent: acceptedUserAgent || 'unknown',
        agreement_url: agreementUrl || null,
        agreement_type: 'embedded',
      },
    };

    const ctx = {
      entityType: record.entityType,
      entityId: record.entityId,
      createdBy: reqMeta.createdBy || null,
      correlationId: reqMeta.correlationId || null,
      requestId: reqMeta.requestId || null,
    };

    try {
      await this.ensureDefaultCapabilityRequests(record, ctx);
    } catch (capErr) {
      logger.error('[AccountService] ensureDefaultCapabilityRequests failed', { recordId, error: capErr.message });
      throw capErr;
    }

    let straddleData;
    const useSandboxSimulate = straddleConfig.isStraddleSandbox();
    const straddleId = String(record.straddleAccountId).trim();

    logger.info('[AccountService] submitOnboarding', {
      recordId,
      straddleAccountId: straddleId,
      sandboxSimulate: useSandboxSimulate,
    });

    try {
      if (useSandboxSimulate) {
        try {
          straddleData = await client.onboardAccount(straddleId, payload, ctx);
        } catch (onboardErr) {
          logger.warn('[AccountService] sandbox onboard before simulate failed (continuing)', {
            recordId,
            straddleAccountId: straddleId,
            error: onboardErr.message,
          });
        }
        straddleData = await client.simulateAccountOnboardingComplete(straddleId, ctx);
        record.metadata = {
          ...(record.metadata || {}),
          onboardingSimulatedAt: DateUtil.toISO(ClockService.now()),
          onboardingSimulationSteps: ['onboarding', 'active'],
        };
      } else {
        straddleData = await client.onboardAccount(straddleId, payload, ctx);
      }
    } catch (err) {
      logger.error('[AccountService] onboarding submit failed', {
        recordId,
        sandboxSimulate: useSandboxSimulate,
        error: err.message,
      });
      const fail = new Error(err.message || 'Failed to submit onboarding to Straddle.');
      fail.statusCode = err.statusCode || 502;
      throw fail;
    }

    record.onboardingStatus = useSandboxSimulate
      ? ONBOARDING_STATUS.COMPLETED
      : ONBOARDING_STATUS.SUBMITTED;
    record.termsOfService = {
      acceptedAt,
      acceptedIp: reqMeta.clientIp || null,
      acceptedUserAgent: acceptedUserAgent || null,
      agreementType: 'embedded',
      agreementUrl: agreementUrl || null,
    };
    record.onboardingWizardStep = 5;
    record.latestResponse = straddleData || record.latestResponse;
    record.updatedBy = reqMeta.createdBy || null;
    await record.save();

    auditAccount({
      event: AUDIT_EVENTS.ONBOARDING_SUBMITTED,
      createdBy: reqMeta.createdBy,
      before: null,
      after: { recordId, straddleAccountId: record.straddleAccountId },
    });

    try {
      return await this.syncAccount(recordId, {
        createdBy: reqMeta.createdBy,
        correlationId: reqMeta.correlationId,
        requestId: reqMeta.requestId,
      });
    } catch (syncErr) {
      logger.warn('[AccountService] post-onboard sync failed', { error: syncErr.message });
      return record.toObject();
    }
  }
}

module.exports = { AccountService };
