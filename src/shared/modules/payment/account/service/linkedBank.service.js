'use strict';

const { ClockService, DateUtil } = require('../../../../../common/date');

const LinkedBankAccount = require('../model/linkedBankAccount.model');
const StraddleAccount = require('../model/straddleAccount.model');
const { StraddleAccountClient } = require('./straddleAccountClient');
const { auditAccount } = require('./accountAudit.helper');
const { assertAccountAccess } = require('./accountAccess.helper');
const {
  LINKED_BANK_STATUS,
  LINKED_BANK_PURPOSE,
  LINKED_BANK_AUDIT_EVENTS,
} = require('../constants/linkedBank.constants');
const logger = require('../../../../../common/logger');

const client = new StraddleAccountClient();

function mapVerification(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'active') return 'verified';
  if (s === 'rejected') return 'failed';
  if (s === 'canceled' || s === 'inactive') return 'canceled';
  return 'pending';
}

class LinkedBankService {

  async _getOwnedAccount(accountLocalId, ownership) {
    const account = await StraddleAccount.findOne({ _id: accountLocalId, isDeleted: { $ne: true } });
    assertAccountAccess(account, ownership);
    if (!account.straddleAccountId) {
      const err = new Error('Account is not registered with Straddle yet. Create/sync the account first.');
      err.statusCode = 400;
      throw err;
    }
    return account;
  }

  /**
   * Create linked bank via Straddle Embed API, then persist locally.
   * Does NOT touch PaymentCustomer / paykey bank flow.
   */
  async createLinkedBank(accountLocalId, input, ownership = {}) {
    const account = await this._getOwnedAccount(accountLocalId, ownership);
    const { holderName, accountNumber, routingNumber, accountType, purposes, description, metadata, isPrimary } = input;

    const routing = String(routingNumber).replace(/\D/g, '');
    const number = String(accountNumber).replace(/\D/g, '');
    if (routing.length !== 9) {
      const err = new Error('Routing number must be 9 digits.');
      err.statusCode = 400;
      throw err;
    }
    if (number.length < 4 || number.length > 17) {
      const err = new Error('Account number must be between 4 and 17 digits.');
      err.statusCode = 400;
      throw err;
    }

    // Soft cap: Straddle allows up to 3 active linked banks
    const activeCount = await LinkedBankAccount.countDocuments({
      straddleAccountRef: account._id,
      isDeleted: { $ne: true },
      status: { $in: [LINKED_BANK_STATUS.CREATED, LINKED_BANK_STATUS.ONBOARDING, LINKED_BANK_STATUS.ACTIVE] },
    });
    if (activeCount >= 3) {
      const err = new Error('This account already has the maximum of 3 linked bank accounts.');
      err.statusCode = 409;
      throw err;
    }

    const straddlePayload = {
      account_id: account.straddleAccountId,
      bank_account: {
        account_holder: holderName.trim(),
        routing_number: routing,
        account_number: number,
      },
      purposes: purposes?.length
        ? purposes
        : [LINKED_BANK_PURPOSE.CHARGES, LINKED_BANK_PURPOSE.PAYOUTS],
      ...(description ? { description } : {}),
      ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
    };

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
      straddleData = await client.createLinkedBankAccount(straddlePayload, ctx);
    } catch (err) {
      logger.error('[LinkedBankService] Straddle createLinkedBankAccount failed', {
        accountId: account._id,
        error: err.message,
        statusCode: err.statusCode,
      });
      const fail = new Error(err.message || 'Failed to link bank account with Straddle.');
      fail.statusCode = err.statusCode || 502;
      fail.straddleError = err.straddleError || null;
      throw fail;
    }

    if (!straddleData?.id) {
      const err = new Error('Straddle did not return a linked bank account id.');
      err.statusCode = 502;
      throw err;
    }

    const status = straddleData.status || LINKED_BANK_STATUS.CREATED;
    const existingPrimary = await LinkedBankAccount.findOne({
      straddleAccountRef: account._id,
      isDeleted: { $ne: true },
      isPrimary: true,
    });

    const makePrimary = isPrimary === true || !existingPrimary;

    const bank = await LinkedBankAccount.create({
      straddleAccountRef: account._id,
      businessId: account.businessId,
      entityType: account.entityType,
      entityId: account.entityId,
      straddleAccountId: account.straddleAccountId,
      linkedBankAccountId: straddleData.id,
      holderName: holderName.trim(),
      routingNumber: routing,
      last4: number.slice(-4),
      accountType: accountType || 'unknown',
      description: description || null,
      purposes: straddleData.purposes || straddlePayload.purposes,
      status,
      statusDetail: straddleData.status_detail || null,
      verificationStatus: mapVerification(status),
      straddleReady: status === LINKED_BANK_STATUS.ACTIVE,
      isPrimary: makePrimary,
      metadata: metadata || {},
      latestRequest: {
        ...straddlePayload,
        bank_account: {
          account_holder: holderName.trim(),
          routing_number: routing,
          account_number: `****${number.slice(-4)}`,
        },
      },
      latestResponse: straddleData,
      createdBy: ownership.userId || null,
    });

    auditAccount({
      event: LINKED_BANK_AUDIT_EVENTS.LINKED_BANK_CREATED,
      createdBy: ownership.userId,
      before: null,
      after: {
        linkedBankId: bank._id,
        linkedBankAccountId: bank.linkedBankAccountId,
        status: bank.status,
        accountId: account._id,
      },
    });

    logger.info('[LinkedBankService] Linked bank created', {
      accountId: account._id,
      bankId: bank._id,
      linkedBankAccountId: bank.linkedBankAccountId,
    });

    await StraddleAccount.updateOne(
      { _id: account._id },
      { $max: { onboardingWizardStep: 3 }, updatedBy: ownership.userId || null }
    );

    return bank;
  }

  async setPrimaryLinkedBank(accountLocalId, bankLocalId, ownership = {}) {
    const account = await this._getOwnedAccount(accountLocalId, ownership);
    const bank = await LinkedBankAccount.findOne({
      _id: bankLocalId,
      straddleAccountRef: account._id,
      isDeleted: { $ne: true },
    });
    if (!bank) {
      const err = new Error('Linked bank account not found');
      err.statusCode = 404;
      throw err;
    }

    await LinkedBankAccount.updateMany(
      { straddleAccountRef: account._id, isDeleted: { $ne: true } },
      { $set: { isPrimary: false, updatedBy: ownership.userId || null } }
    );

    bank.isPrimary = true;
    bank.updatedBy = ownership.userId || null;
    await bank.save();

    auditAccount({
      event: LINKED_BANK_AUDIT_EVENTS.LINKED_BANK_UPDATED,
      createdBy: ownership.userId,
      before: null,
      after: { bankId: bank._id, isPrimary: true },
    });

    return bank.toObject();
  }

  async listLinkedBanks(accountLocalId, ownership = {}) {
    const account = await this._getOwnedAccount(accountLocalId, ownership);
    return LinkedBankAccount.find({
      straddleAccountRef: account._id,
      isDeleted: { $ne: true },
    }).sort({ createdAt: -1 }).lean();
  }

  async getLinkedBank(accountLocalId, bankLocalId, ownership = {}) {
    await this._getOwnedAccount(accountLocalId, ownership);
    const bank = await LinkedBankAccount.findOne({
      _id: bankLocalId,
      straddleAccountRef: accountLocalId,
      isDeleted: { $ne: true },
    }).lean();
    if (!bank) {
      const err = new Error('Linked bank account not found');
      err.statusCode = 404;
      throw err;
    }
    return bank;
  }

  async syncLinkedBank(accountLocalId, bankLocalId, ownership = {}) {
    const account = await this._getOwnedAccount(accountLocalId, ownership);
    const bank = await LinkedBankAccount.findOne({
      _id: bankLocalId,
      straddleAccountRef: account._id,
      isDeleted: { $ne: true },
    });
    if (!bank) {
      const err = new Error('Linked bank account not found');
      err.statusCode = 404;
      throw err;
    }
    if (!bank.linkedBankAccountId) {
      const err = new Error('Bank is not registered with Straddle');
      err.statusCode = 400;
      throw err;
    }

    const ctx = {
      entityType: account.entityType,
      entityId: account.entityId,
      straddleAccountId: account.straddleAccountId,
      createdBy: ownership.userId || null,
      correlationId: ownership.correlationId,
      requestId: ownership.requestId,
    };

    const straddleData = await client.getLinkedBankAccount(bank.linkedBankAccountId, ctx);
    const before = { status: bank.status, verificationStatus: bank.verificationStatus };

    bank.status = straddleData.status || bank.status;
    bank.statusDetail = straddleData.status_detail || bank.statusDetail;
    bank.verificationStatus = mapVerification(bank.status);
    bank.straddleReady = bank.status === LINKED_BANK_STATUS.ACTIVE;
    bank.purposes = straddleData.purposes || bank.purposes;
    bank.latestResponse = straddleData;
    bank.lastSyncedAt = ClockService.now();
    bank.updatedBy = ownership.userId || null;
    await bank.save();

    auditAccount({
      event: LINKED_BANK_AUDIT_EVENTS.LINKED_BANK_SYNCED,
      createdBy: ownership.userId,
      before,
      after: { status: bank.status, verificationStatus: bank.verificationStatus },
    });

    return bank.toObject();
  }

  /**
   * Update linked bank via Straddle PUT /v1/linked_bank_accounts/{id}.
   * Only allowed when status is created or onboarding.
   */
  async updateLinkedBank(accountLocalId, bankLocalId, input, ownership = {}) {
    const account = await this._getOwnedAccount(accountLocalId, ownership);
    const bank = await LinkedBankAccount.findOne({
      _id: bankLocalId,
      straddleAccountRef: account._id,
      isDeleted: { $ne: true },
    });
    if (!bank) {
      const err = new Error('Linked bank account not found');
      err.statusCode = 404;
      throw err;
    }
    if (!bank.linkedBankAccountId) {
      const err = new Error('Bank is not registered with Straddle');
      err.statusCode = 400;
      throw err;
    }

    const editable = [LINKED_BANK_STATUS.CREATED, LINKED_BANK_STATUS.ONBOARDING];
    if (!editable.includes(bank.status)) {
      const err = new Error(
        `Linked bank can only be edited while status is created or onboarding (current: ${bank.status}).`
      );
      err.statusCode = 409;
      throw err;
    }

    const { holderName, accountNumber, routingNumber, accountType, metadata } = input;
    const routing = String(routingNumber).replace(/\D/g, '');
    const number = String(accountNumber).replace(/\D/g, '');
    if (routing.length !== 9) {
      const err = new Error('Routing number must be 9 digits.');
      err.statusCode = 400;
      throw err;
    }
    if (number.length < 4 || number.length > 17) {
      const err = new Error('Account number must be between 4 and 17 digits.');
      err.statusCode = 400;
      throw err;
    }

    const straddlePayload = {
      bank_account: {
        account_holder: holderName.trim(),
        routing_number: routing,
        account_number: number,
      },
      ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
    };

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
      straddleData = await client.updateLinkedBankAccount(bank.linkedBankAccountId, straddlePayload, ctx);
    } catch (err) {
      logger.error('[LinkedBankService] Straddle updateLinkedBankAccount failed', {
        bankId: bank._id,
        error: err.message,
        statusCode: err.statusCode,
      });
      const fail = new Error(err.message || 'Failed to update linked bank account with Straddle.');
      fail.statusCode = err.statusCode || 502;
      fail.straddleError = err.straddleError || null;
      throw fail;
    }

    const before = {
      holderName: bank.holderName,
      routingNumber: bank.routingNumber,
      last4: bank.last4,
      status: bank.status,
    };

    bank.holderName = holderName.trim();
    bank.routingNumber = routing;
    bank.last4 = number.slice(-4);
    if (accountType) bank.accountType = accountType;
    bank.status = straddleData?.status || bank.status;
    bank.statusDetail = straddleData?.status_detail || bank.statusDetail;
    bank.verificationStatus = mapVerification(bank.status);
    bank.straddleReady = bank.status === LINKED_BANK_STATUS.ACTIVE;
    bank.latestRequest = {
      ...straddlePayload,
      bank_account: {
        account_holder: holderName.trim(),
        routing_number: routing,
        account_number: `****${number.slice(-4)}`,
      },
    };
    bank.latestResponse = straddleData || bank.latestResponse;
    bank.updatedBy = ownership.userId || null;
    if (metadata) bank.metadata = { ...(bank.metadata || {}), ...metadata };
    await bank.save();

    auditAccount({
      event: LINKED_BANK_AUDIT_EVENTS.LINKED_BANK_UPDATED,
      createdBy: ownership.userId,
      before,
      after: {
        holderName: bank.holderName,
        last4: bank.last4,
        status: bank.status,
        linkedBankAccountId: bank.linkedBankAccountId,
      },
    });

    logger.info('[LinkedBankService] Linked bank updated', {
      bankId: bank._id,
      linkedBankAccountId: bank.linkedBankAccountId,
    });
    return bank.toObject();
  }

  async cancelLinkedBank(accountLocalId, bankLocalId, ownership = {}) {
    const account = await this._getOwnedAccount(accountLocalId, ownership);
    const bank = await LinkedBankAccount.findOne({
      _id: bankLocalId,
      straddleAccountRef: account._id,
      isDeleted: { $ne: true },
    });
    if (!bank) {
      const err = new Error('Linked bank account not found');
      err.statusCode = 404;
      throw err;
    }

    const beforeSnapshot = {
      bankId: bank._id,
      linkedBankAccountId: bank.linkedBankAccountId,
      holderName: bank.holderName,
      last4: bank.last4,
      status: bank.status,
      verificationStatus: bank.verificationStatus,
    };

    if (bank.linkedBankAccountId && bank.status === LINKED_BANK_STATUS.CREATED) {
      try {
        await client.cancelLinkedBankAccount(bank.linkedBankAccountId, {
          entityType: account.entityType,
          entityId: account.entityId,
          straddleAccountId: account.straddleAccountId,
          createdBy: ownership.userId || null,
          correlationId: ownership.correlationId,
          requestId: ownership.requestId,
        });
      } catch (err) {
        // If already past created, fall through to local soft-delete
        logger.warn('[LinkedBankService] Straddle cancel failed', { error: err.message, statusCode: err.statusCode });
        if (err.statusCode && err.statusCode < 500 && err.statusCode !== 404 && err.statusCode !== 409) {
          throw err;
        }
      }
    }

    bank.status = LINKED_BANK_STATUS.CANCELED;
    bank.verificationStatus = 'canceled';
    bank.straddleReady = false;
    bank.isDeleted = true;
    bank.deletedAt = ClockService.now();
    bank.deletedBy = ownership.userId || null;
    await bank.save();

    auditAccount({
      event: LINKED_BANK_AUDIT_EVENTS.LINKED_BANK_CANCELED,
      createdBy: ownership.userId,
      before: beforeSnapshot,
      after: { bankId: bank._id, linkedBankAccountId: bank.linkedBankAccountId, status: bank.status },
      req: ownership.req || null,
      entity: 'LinkedBankAccount',
      entityId: String(bank._id),
    });

    return bank.toObject();
  }

  /** Apply status from webhook by Straddle linked_bank_account id */
  async applyStatusFromWebhook(linkedBankAccountId, data) {
    if (!linkedBankAccountId && !data?.id) return null;
    const id = linkedBankAccountId || data.id;
    const bank = await LinkedBankAccount.findOne({ linkedBankAccountId: id, isDeleted: { $ne: true } });
    if (!bank) {
      logger.warn('[LinkedBankService] webhook: no local bank for', { linkedBankAccountId: id });
      return null;
    }

    const before = { status: bank.status, verificationStatus: bank.verificationStatus };
    if (data.status) bank.status = data.status;
    if (data.status_detail) bank.statusDetail = data.status_detail;
    if (data.purposes) bank.purposes = data.purposes;
    bank.verificationStatus = mapVerification(bank.status);
    bank.straddleReady = bank.status === LINKED_BANK_STATUS.ACTIVE;
    bank.latestResponse = data;
    bank.lastWebhookAt = ClockService.now();
    await bank.save();

    auditAccount({
      event: LINKED_BANK_AUDIT_EVENTS.LINKED_BANK_WEBHOOK,
      before,
      after: { status: bank.status, verificationStatus: bank.verificationStatus, linkedBankAccountId: id },
      source: 'WEBHOOK',
      entity: 'LinkedBankAccount',
      entityId: String(bank._id),
    });

    return bank;
  }
}

module.exports = { LinkedBankService };
