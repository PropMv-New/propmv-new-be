'use strict';

const crypto = require('crypto');
const AccountRepresentative = require('../model/accountRepresentative.model');
const StraddleAccount = require('../model/straddleAccount.model');
const { StraddleAccountClient } = require('./straddleAccountClient');
const { assertAccountAccess } = require('./accountAccess.helper');
const { auditAccount, AUDIT_EVENTS } = require('./accountAudit.helper');
const logger = require('../../../../../common/logger');

const client = new StraddleAccountClient();

function normalizeDob(dob) {
  const s = String(dob || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return s;
}

function normalizeMobile(phone) {
  if (!phone) return phone;
  const trimmed = String(phone).trim();
  if (/^\+[1-9]\d{1,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed;
}

function buildStraddleRepPayload(account, input, externalId) {
  return {
    account_id: account.straddleAccountId,
    first_name: input.firstName.trim(),
    last_name: input.lastName.trim(),
    dob: normalizeDob(input.dob),
    ...(input.ssnLast4 ? { ssn_last4: String(input.ssnLast4).replace(/\D/g, '').slice(-4) } : {}),
    email: input.email.trim(),
    mobile_number: normalizeMobile(input.mobileNumber),
    relationship: {
      primary: input.relationship?.primary !== false,
      control: input.relationship?.control !== false,
      owner: !!input.relationship?.owner,
      percent_ownership: input.relationship?.percentOwnership ?? undefined,
      title: input.relationship?.title || undefined,
    },
    external_id: externalId,
  };
}

class RepresentativeService {
  async _getOwnedAccount(accountLocalId, ownership) {
    const account = await StraddleAccount.findOne({ _id: accountLocalId, isDeleted: { $ne: true } });
    assertAccountAccess(account, ownership);
    if (!account.straddleAccountId) {
      const err = new Error('Account is not registered with Straddle yet.');
      err.statusCode = 400;
      throw err;
    }
    return account;
  }

  async listRepresentatives(accountLocalId, ownership = {}) {
    await this._getOwnedAccount(accountLocalId, ownership);
    return AccountRepresentative.find({
      straddleAccountRef: accountLocalId,
      isDeleted: { $ne: true },
    })
      .sort({ createdAt: -1 })
      .lean();
  }

  async createRepresentative(accountLocalId, input, ownership = {}) {
    const account = await this._getOwnedAccount(accountLocalId, ownership);

    const externalId = `rep_${String(account._id)}_${crypto.randomBytes(4).toString('hex')}`;
    const straddlePayload = buildStraddleRepPayload(account, input, externalId);

    const ctx = {
      entityType: account.entityType,
      entityId: account.entityId,
      straddleAccountId: account.straddleAccountId,
      createdBy: ownership.userId || null,
      correlationId: ownership.correlationId,
      requestId: ownership.requestId,
    };

    let straddleData;
    try {
      straddleData = await client.createRepresentative(straddlePayload, ctx);
    } catch (err) {
      logger.error('[RepresentativeService] create failed', { error: err.message, statusCode: err.statusCode });
      const fail = new Error(err.message || 'Failed to add representative with Straddle.');
      fail.statusCode = err.statusCode || 502;
      throw fail;
    }

    if (!straddleData?.id) {
      const err = new Error('Straddle did not return a representative id.');
      err.statusCode = 502;
      throw err;
    }

    const rep = await AccountRepresentative.create({
      straddleAccountRef: account._id,
      businessId: account.businessId,
      entityType: account.entityType,
      entityId: account.entityId,
      straddleAccountId: account.straddleAccountId,
      straddleRepresentativeId: straddleData.id,
      externalId,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      dob: normalizeDob(input.dob),
      ssnLast4: input.ssnLast4 ? String(input.ssnLast4).replace(/\D/g, '').slice(-4) : null,
      email: input.email.trim(),
      mobileNumber: normalizeMobile(input.mobileNumber),
      relationship: {
        primary: input.relationship?.primary !== false,
        control: input.relationship?.control !== false,
        owner: !!input.relationship?.owner,
        percentOwnership: input.relationship?.percentOwnership ?? null,
        title: input.relationship?.title || null,
      },
      status: straddleData.status || 'created',
      latestRequest: straddlePayload,
      latestResponse: straddleData,
      createdBy: ownership.userId || null,
    });

    await StraddleAccount.updateOne(
      { _id: account._id },
      { $max: { onboardingWizardStep: 2 }, updatedBy: ownership.userId || null }
    );

    auditAccount({
      event: AUDIT_EVENTS.ACCOUNT_UPDATED,
      createdBy: ownership.userId,
      before: null,
      after: { representativeId: rep._id, straddleRepresentativeId: rep.straddleRepresentativeId },
    });

    return rep.toObject();
  }

  async updateRepresentative(accountLocalId, repLocalId, input, ownership = {}) {
    const account = await this._getOwnedAccount(accountLocalId, ownership);
    const rep = await AccountRepresentative.findOne({
      _id: repLocalId,
      straddleAccountRef: account._id,
      isDeleted: { $ne: true },
    });
    if (!rep) {
      const err = new Error('Representative not found');
      err.statusCode = 404;
      throw err;
    }
    const before = {
      representativeId: String(rep._id),
      firstName: rep.firstName || '',
      lastName: rep.lastName || '',
      email: rep.email || '',
      status: rep.status || '',
    };
    if (!rep.straddleRepresentativeId) {
      const err = new Error('Representative is not registered with Straddle');
      err.statusCode = 400;
      throw err;
    }

    const straddlePayload = {};
    if (input.firstName) straddlePayload.first_name = input.firstName.trim();
    if (input.lastName) straddlePayload.last_name = input.lastName.trim();
    if (input.dob) straddlePayload.dob = normalizeDob(input.dob);
    if (input.ssnLast4) straddlePayload.ssn_last4 = String(input.ssnLast4).replace(/\D/g, '').slice(-4);
    if (input.email) straddlePayload.email = input.email.trim();
    if (input.mobileNumber) straddlePayload.mobile_number = normalizeMobile(input.mobileNumber);
    if (input.relationship) {
      straddlePayload.relationship = {
        ...(input.relationship.primary !== undefined ? { primary: input.relationship.primary } : {}),
        ...(input.relationship.control !== undefined ? { control: input.relationship.control } : {}),
        ...(input.relationship.owner !== undefined ? { owner: input.relationship.owner } : {}),
        ...(input.relationship.percentOwnership !== undefined
          ? { percent_ownership: input.relationship.percentOwnership }
          : {}),
        ...(input.relationship.title !== undefined ? { title: input.relationship.title || undefined } : {}),
      };
    }

    const ctx = {
      entityType: account.entityType,
      entityId: account.entityId,
      straddleAccountId: account.straddleAccountId,
      createdBy: ownership.userId || null,
      correlationId: ownership.correlationId,
      requestId: ownership.requestId,
    };

    let straddleData;
    try {
      straddleData = await client.updateRepresentative(rep.straddleRepresentativeId, straddlePayload, ctx);
    } catch (err) {
      const fail = new Error(err.message || 'Failed to update representative with Straddle.');
      fail.statusCode = err.statusCode || 502;
      throw fail;
    }

    if (input.firstName) rep.firstName = input.firstName.trim();
    if (input.lastName) rep.lastName = input.lastName.trim();
    if (input.dob) rep.dob = normalizeDob(input.dob);
    if (input.ssnLast4) rep.ssnLast4 = String(input.ssnLast4).replace(/\D/g, '').slice(-4);
    if (input.email) rep.email = input.email.trim();
    if (input.mobileNumber) rep.mobileNumber = normalizeMobile(input.mobileNumber);
    if (input.relationship) {
      rep.relationship = {
        ...rep.relationship.toObject?.() || rep.relationship,
        ...input.relationship,
      };
    }
    rep.latestResponse = straddleData || rep.latestResponse;
    rep.updatedBy = ownership.userId || null;
    await rep.save();

    auditAccount({
      event: AUDIT_EVENTS.ACCOUNT_UPDATED,
      createdBy: ownership.userId,
      before,
      after: {
        representativeId: String(rep._id),
        firstName: rep.firstName || '',
        lastName: rep.lastName || '',
        email: rep.email || '',
        status: rep.status || '',
      },
      req: ownership.req || null,
      entity: 'AccountRepresentative',
      entityId: String(rep._id),
    });

    return rep.toObject();
  }
}

module.exports = { RepresentativeService };
