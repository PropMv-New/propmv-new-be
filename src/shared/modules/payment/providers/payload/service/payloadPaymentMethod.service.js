'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { ClockService } = require('../../../../../../common/date');
const PayloadPaymentMethod = require('../model/payloadPaymentMethod.model');
const PayloadUser = require('../model/payloadUser.model');
const { PayloadClient } = require('../client/payload.client');
const {
  PAYMENT_METHOD_STATUS,
  PAYMENT_METHOD_TYPE,
  AUDIT_EVENTS,
  ENTITY_TYPE,
} = require('../constants/payload.constants');
const { createPaymentMethodSession } = require('./payloadComponentSession.service');
const {
  ensurePayloadEnabled,
} = require('./payloadMerchant.service');
const payloadConfig = require('../../../../../../config/payload.config');
const { resolvePlatformIdForBillableMerchant } = require('../utils/payloadPlatform.util');
const {
  buildEntityBillableMerchantQuery,
  billableMerchantUnavailableMessage,
  findActiveBillableMerchantId,
} = require('../utils/payloadBillableMerchant.util');
const { resolvePayloadHoaOwnerBillableMerchantId } = require('../utils/payloadHoaOwnerBillableMerchant.util');
const {
  buildHoaOwnerPayloadScopeKey,
  buildHoaOwnerPayloadExternalUid,
  isHoaOwnerPayloadScopeKey,
  isHoaOwnerBillableMerchantInputValid,
  resolveHoaOwnerPayloadCustomerContext,
  buildHoaOwnerPaymentMethodListOrFilters,
} = require('../utils/payloadHoaOwnerCustomerContext.util');
const {
  dedupeHoaOwnerPaymentMethodsForList,
  findHoaOwnerPaymentMethodDuplicateIds,
  buildHoaOwnerPaymentMethodMetadataPatch,
  buildOwnerPaymentMethodIdentityKey,
} = require('../utils/payloadHoaOwnerPaymentMethodList.util');
const { auditPayload } = require('./payloadAudit.helper');
const {
  allowedMethodsNeedOriginatingMerchant,
  isWalletMethodType,
  PAYLOAD_CARDS_SECTION_ALLOWED_METHODS,
  resolveRemotePaymentMethodType,
} = require('../utils/payloadPaymentMethodType.util');
const logger = require('../../../../../../common/logger');

const client = new PayloadClient();

function hoaOwnerWalletContextOptions(ownerUserId) {
  return {
    findActiveBillableMerchantId,
    ownerUserId,
  };
}

/**
 * Active HOAMembership → Board Member of that community (payer Settings / Phase 5).
 * Owners typically have no membership row and use unit→landlord merchant scoping instead.
 */
async function isActiveHoaBoardMember(userId, hoaId) {
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);
  if (!userOid || !hoaOid) return false;
  const HOAMembership = require('../../../../../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
  const membership = await HOAMembership.findOne({
    userId: userOid,
    hoaId: hoaOid,
    status: 'active',
  }).select('_id').lean();
  return Boolean(membership);
}

/**
 * Resolve HOA wallet Customer context for the actor.
 * - Board Member: community merchants for Payload Customer hosting only
 *   (billableMerchantId stays hoa:{hoaId}; never Owner unit-assignment filter).
 * - Owner: keep unit→board-member merchant scoping (existing rent/dues wallet).
 */
async function resolveHoaPayloadWalletContextForActor(userId, hoaId) {
  const boardMember = await isActiveHoaBoardMember(userId, hoaId);
  if (boardMember) {
    const ctx = await resolveHoaOwnerPayloadCustomerContext(hoaId, {
      findActiveBillableMerchantId,
      // Omit ownerUserId so boardMemberIds stays undefined (not []).
    });
    return { ...ctx, actorIsBoardMember: true };
  }
  const ctx = await resolveHoaOwnerPayloadCustomerContext(
    hoaId,
    hoaOwnerWalletContextOptions(userId),
  );
  return { ...ctx, actorIsBoardMember: false };
}

function resolveHoaOwnerWalletUnavailableReason(ctx) {
  if (ctx?.actorIsBoardMember) {
    return 'board_no_hoa_merchant';
  }
  // Empty boardMemberIds array means Owner unit-assignment found no board landlords.
  // Board actors never get that array (omit ownerUserId); do not use Owner copy for them.
  if (Array.isArray(ctx?.boardMemberIds) && ctx.boardMemberIds.length === 0) {
    return 'no_board_member_scope';
  }
  return 'no_board_member_merchants';
}

function resolveHoaOwnerWalletProcessingId(hoaCustomerContext) {
  if (!hoaCustomerContext) return '';
  const { resolvePayloadPrimaryProcessingIdForOwnerWallet } = require('../utils/payloadHoaOwnerProcessingAccount.util');
  return resolvePayloadPrimaryProcessingIdForOwnerWallet(hoaCustomerContext);
}

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

function normalizeAccountType(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('saving')) return 'savings';
  if (raw.includes('check')) return 'checking';
  return raw || '';
}

function parseLast4FromDescription(description) {
  const match = String(description || '').match(/(\d{4})\s*$/);
  return match ? match[1] : '';
}

/** Payload returns masked card_number / account_number — keep only the last 4 digits. */
function extractLast4FromOpaqueNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const digits = String(value).replace(/\D/g, '');
    if (digits.length >= 4) return digits.slice(-4);
    const fromDesc = parseLast4FromDescription(value);
    if (fromDesc) return fromDesc;
  }
  return '';
}

function parseCardExpiry(card = {}) {
  if (card.exp_month != null || card.expMonth != null) {
    const expMonth = Number(card.exp_month ?? card.expMonth);
    const expYear = Number(card.exp_year ?? card.expYear);
    return {
      expMonth: Number.isFinite(expMonth) ? expMonth : null,
      expYear: Number.isFinite(expYear) ? expYear : null,
    };
  }
  const match = String(card.expiry || '').match(/^(\d{1,2})\s*[/-]\s*(\d{2,4})$/);
  if (!match) return { expMonth: null, expYear: null };
  const expMonth = Number(match[1]);
  let expYear = Number(match[2]);
  if (String(match[2]).length === 2) expYear += 2000;
  return {
    expMonth: Number.isFinite(expMonth) ? expMonth : null,
    expYear: Number.isFinite(expYear) ? expYear : null,
  };
}

function extractDisplayMetadata(remote = {}) {
  const methodType = resolveRemotePaymentMethodType(remote);
  const card = remote?.card || {};
  const ach = remote?.ach || remote?.plaid_ach || remote?.validated_ach || remote?.bank_account || {};
  const applePay = remote?.apple_pay || {};
  const googlePay = remote?.google_pay || {};
  const paypalWallet = remote?.paypal_wallet || {};
  const venmo = remote?.venmo || {};
  const paypalPaylater = remote?.paypal_paylater || {};
  const billing = remote?.billing_contact || remote?.billingContact || {};

  const base = {
    accountType: '',
    bankName: '',
    holderName: remote?.account_holder || billing?.name || ach?.account_holder_name || ach?.accountHolderName || '',
    routingNumber: ach?.routing_number || ach?.routingNumber || '',
    fingerprint: remote?.fingerprint || card?.fingerprint || ach?.fingerprint || '',
    methodType: methodType || PAYMENT_METHOD_TYPE.CARD,
    walletLabel: '',
  };

  if (methodType === PAYMENT_METHOD_TYPE.APPLE_PAY) {
    const description = applePay.description || applePay.brand_desc || '';
    return {
      ...base,
      brand: applePay.brand_desc || applePay.brand || applePay.card_brand || 'Apple Pay',
      last4: extractLast4FromOpaqueNumber(description, applePay.card_number),
      expMonth: null,
      expYear: null,
      walletLabel: description || 'Apple Pay',
      methodType: PAYMENT_METHOD_TYPE.APPLE_PAY,
    };
  }

  if (methodType === PAYMENT_METHOD_TYPE.GOOGLE_PAY) {
    const description = googlePay.description || googlePay.brand_desc || '';
    return {
      ...base,
      brand: googlePay.brand_desc || googlePay.brand || googlePay.card_brand || 'Google Pay',
      last4: extractLast4FromOpaqueNumber(description, googlePay.card_number),
      expMonth: null,
      expYear: null,
      walletLabel: description || 'Google Pay',
      methodType: PAYMENT_METHOD_TYPE.GOOGLE_PAY,
    };
  }

  if (methodType === PAYMENT_METHOD_TYPE.PAYPAL_WALLET) {
    const walletLabel =
      paypalWallet.email
      || paypalWallet.description
      || paypalWallet.payer_id
      || 'PayPal';
    return {
      ...base,
      brand: 'PayPal',
      last4: '',
      walletLabel,
      methodType: PAYMENT_METHOD_TYPE.PAYPAL_WALLET,
    };
  }

  if (methodType === PAYMENT_METHOD_TYPE.VENMO) {
    const walletLabel =
      venmo.username
      || venmo.display_name
      || venmo.description
      || 'Venmo';
    return {
      ...base,
      brand: 'Venmo',
      last4: '',
      walletLabel,
      methodType: PAYMENT_METHOD_TYPE.VENMO,
    };
  }

  if (methodType === PAYMENT_METHOD_TYPE.PAYPAL_PAYLATER) {
    return {
      ...base,
      brand: 'PayPal Pay Later',
      last4: '',
      walletLabel: paypalPaylater.description || 'PayPal Pay Later',
      methodType: PAYMENT_METHOD_TYPE.PAYPAL_PAYLATER,
    };
  }

  // Payload PaymentMethod object reference uses card_brand / card_number / expiry,
  // and bank_account / top-level bank_name (not Stripe-style brand/last4).
  const { expMonth, expYear } = parseCardExpiry(card);
  return {
    ...base,
    brand: card?.card_brand || card?.brand || card?.scheme || '',
    last4: extractLast4FromOpaqueNumber(
      card?.last4,
      card?.last_4,
      card?.card_number,
      ach?.account_number_last_4,
      ach?.account_number_last4,
      ach?.account_number,
      ach?.last4,
      remote?.description,
    ),
    expMonth,
    expYear,
    accountType: normalizeAccountType(ach?.account_type || ach?.accountType),
    bankName:
      remote?.bank_name
      || ach?.bank_name
      || ach?.bankName
      || ach?.institution_name
      || '',
    holderName:
      base.holderName
      || remote?.account_holder
      || '',
  };
}

function buildDisplayPayload(displayMeta = {}) {
  return {
    brand: displayMeta.brand || '',
    last4: displayMeta.last4 || '',
    expMonth: displayMeta.expMonth ?? null,
    expYear: displayMeta.expYear ?? null,
    accountType: displayMeta.accountType || '',
    bankName: displayMeta.bankName || '',
    holderName: displayMeta.holderName || '',
    routingNumber: displayMeta.routingNumber || '',
    fingerprint: displayMeta.fingerprint || '',
    walletLabel: displayMeta.walletLabel || '',
  };
}

async function refreshPaymentMethodDisplayFromRemote(doc) {
  if (!doc?.providerPaymentMethodId) return doc;

  const type = String(doc.type || '').toUpperCase();
  const isBank = type.includes('ACH') || type.includes('BANK') || type.includes('PLAID');
  const isWallet = isWalletMethodType(type);
  const needsRefresh = isBank
    ? !doc.display?.last4 || !doc.display?.bankName
    : isWallet
      ? !doc.display?.walletLabel && !doc.display?.brand
      : !doc.display?.last4 || !doc.display?.brand;
  if (!needsRefresh) return doc;

  try {
    const remote = await client.getPaymentMethod(doc.providerPaymentMethodId);
    const displayMeta = extractDisplayMetadata(remote || {});
    if (
      !displayMeta.last4
      && !displayMeta.brand
      && !displayMeta.bankName
      && !displayMeta.holderName
      && !displayMeta.walletLabel
    ) {
      return doc;
    }

    doc.display = buildDisplayPayload(displayMeta);
    doc.type = displayMeta.methodType || doc.type;
    doc.lastWebhookAt = ClockService.now();
    await doc.save();
  } catch (err) {
    logger.warn('[PayloadPaymentMethod] Display refresh failed', {
      paymentMethodId: doc.providerPaymentMethodId,
      message: err.message,
    });
  }

  return doc;
}

function sanitizePaymentMethod(doc) {
  if (!doc) return null;
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(row._id),
    provider: row.provider,
    providerPaymentMethodId: row.providerPaymentMethodId,
    paymentMethodConfigId: row.paymentMethodConfigId || '',
    billableMerchantId: row.billableMerchantId || '',
    entityType: row.entityType || null,
    entityId: row.entityId ? String(row.entityId) : null,
    type: row.type,
    status: row.status,
    isDefault: !!row.isDefault,
    display: row.display || {},
    hoaProcessingMerchantIds: Array.isArray(row.hoaProcessingMerchantIds)
      ? row.hoaProcessingMerchantIds
      : (row.metadata?.hoaProcessingMerchantIds || []),
    nickname: String(row.metadata?.ownerDescription || '').trim(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function consolidateHoaOwnerPaymentMethodDuplicates({
  userId,
  hoaId,
  methods,
  merchantIds,
}) {
  const userOid = toObjectId(userId);
  const hoaIdStr = String(hoaId || '').trim();
  if (!userOid || !hoaIdStr || !Array.isArray(methods) || methods.length === 0) return;

  const sanitized = methods.map((row) => sanitizePaymentMethod(
    typeof row.toObject === 'function' ? row.toObject() : row,
  ));
  const duplicateIds = findHoaOwnerPaymentMethodDuplicateIds(sanitized, {
    hoaId: hoaIdStr,
    merchantIds,
  });
  if (!duplicateIds.length) return;

  const metadataPatch = buildHoaOwnerPaymentMethodMetadataPatch(merchantIds);
  await PayloadPaymentMethod.updateMany(
    {
      userId: userOid,
      _id: { $in: duplicateIds.map((id) => toObjectId(id)).filter(Boolean) },
      isDeleted: { $ne: true },
    },
    {
      $set: {
        isDeleted: true,
        deletedAt: ClockService.now(),
      },
    },
  );

  await PayloadPaymentMethod.updateMany(
    {
      userId: userOid,
      isDeleted: { $ne: true },
      $or: [
        { entityType: ENTITY_TYPE.HOA, entityId: toObjectId(hoaIdStr) },
        { billableMerchantId: buildHoaOwnerPayloadScopeKey(hoaIdStr) },
      ],
    },
    {
      $set: {
        'metadata.hoaProcessingMerchantIds': metadataPatch.hoaProcessingMerchantIds,
        'metadata.hoaProcessingMerchantsSyncedAt': metadataPatch.hoaProcessingMerchantsSyncedAt,
      },
    },
  ).catch((err) => {
    logger.warn('[PayloadPaymentMethod] HOA merchant scope metadata sync failed', {
      hoaId: hoaIdStr,
      message: err.message,
    });
  });
}

async function ensurePayloadCustomerForUser({
  userId,
  billableMerchantId,
  primaryProcessingId = null,
  hoaMerchantIds = null,
  hoaId = null,
  user,
  payloadUserRecord,
}) {
  const {
    isPayloadRemoteProcessingAccountId,
    resolvePayloadPrimaryProcessingIdForOwnerWallet,
  } = require('../utils/payloadHoaOwnerProcessingAccount.util');
  const hoaScoped = isHoaOwnerPayloadScopeKey(billableMerchantId);
  const merchantIdList = Array.isArray(hoaMerchantIds) ? hoaMerchantIds : [];
  const payloadPrimaryForHoa = hoaScoped
    ? resolvePayloadPrimaryProcessingIdForOwnerWallet({
      primaryProcessingId,
      merchantIds: merchantIdList,
    })
    : '';
  const expectedPrimary = hoaScoped
    ? payloadPrimaryForHoa
    : String(
      primaryProcessingId
      || (isPayloadRemoteProcessingAccountId(billableMerchantId) ? billableMerchantId : '')
      || '',
    ).trim();

  const existingId = payloadUserRecord?.metadata?.payloadCustomerId;
  if (existingId) {
    try {
      const remote = await client.getCustomer(String(existingId));
      const primary = remote?.primary_processing_id || remote?.primaryProcessingId || '';
      if (
        hoaScoped
        && primary
        && !isPayloadRemoteProcessingAccountId(primary)
      ) {
        logger.warn('[PayloadPaymentMethod] Stale Payload customer has invalid primary_processing_id; recreating customer', {
          userId: String(userId),
          payloadCustomerId: String(existingId),
          remotePrimary: String(primary),
          expectedPrimary: String(expectedPrimary || ''),
        });
        payloadUserRecord.metadata = {
          ...(payloadUserRecord.metadata || {}),
          payloadCustomerId: null,
          previousPayloadCustomerId: String(existingId),
        };
        payloadUserRecord.markModified('metadata');
        await payloadUserRecord.save();
      } else if (
        !hoaScoped
        && primary
        && expectedPrimary
        && String(primary) !== expectedPrimary
      ) {
        logger.warn('[PayloadPaymentMethod] Stale Payload customer for merchant scope; creating new customer', {
          userId: String(userId),
          billableMerchantId: String(billableMerchantId),
          payloadCustomerId: String(existingId),
          primaryProcessingId: String(primary),
        });
        payloadUserRecord.metadata = {
          ...(payloadUserRecord.metadata || {}),
          payloadCustomerId: null,
          previousPayloadCustomerId: String(existingId),
        };
        payloadUserRecord.markModified('metadata');
        await payloadUserRecord.save();
      } else {
        if (
          hoaScoped
          && primary
          && expectedPrimary
          && String(primary) !== expectedPrimary
        ) {
          logger.info('[PayloadPaymentMethod] HOA unified customer primary differs from community default; keeping customer for cross-processing pay-ins', {
            userId: String(userId),
            payloadCustomerId: String(existingId),
            remotePrimary: String(primary),
            communityPrimary: expectedPrimary,
          });
        }
        return String(existingId);
      }
    } catch (err) {
      logger.warn('[PayloadPaymentMethod] Payload customer lookup failed; reusing cached id', {
        payloadCustomerId: String(existingId),
        message: err.message,
      });
      return String(existingId);
    }
  }

  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()
    || user?.email
    || 'PropMv Customer';
  const email = user?.email;
  if (!email) {
    const err = new Error('An email address is required before saving a payment method.');
    err.statusCode = 400;
    throw err;
  }

  const externalUid = hoaScoped && hoaId
    ? buildHoaOwnerPayloadExternalUid(userId, hoaId)
    : String(userId);

  const primaryForCreate = hoaScoped
    ? expectedPrimary
    : (expectedPrimary || (isPayloadRemoteProcessingAccountId(billableMerchantId) ? billableMerchantId : ''));
  if (!primaryForCreate || !isPayloadRemoteProcessingAccountId(primaryForCreate)) {
    const err = new Error(
      hoaScoped
        ? 'No active Payload processing account is available for your HOA board member. Ask your board to complete merchant onboarding.'
        : 'No active Payload business merchant is available for this account yet.',
    );
    err.statusCode = 400;
    throw err;
  }

  const created = await client.createCustomer({
    email,
    name,
    external_uid: externalUid,
    primary_processing_id: String(primaryForCreate),
  });

  const customerId = created?.id || created?.customer_id || '';
  if (!customerId) {
    const err = new Error('Payload did not return a customer id.');
    err.statusCode = 502;
    throw err;
  }

  payloadUserRecord.metadata = {
    ...(payloadUserRecord.metadata || {}),
    payloadCustomerId: customerId,
  };
  payloadUserRecord.lastSyncedAt = ClockService.now();
  await payloadUserRecord.save();

  return String(customerId);
}

async function ensurePayloadUserContext({ userId, billableMerchantId, entityType, entityId }) {
  const userOid = toObjectId(userId);
  if (!userOid) {
    const err = new Error('Invalid user context.');
    err.statusCode = 400;
    throw err;
  }

  const query = {
    userId: userOid,
    billableMerchantId: String(billableMerchantId || ''),
  };

  let record = await PayloadUser.findOne(query);
  if (!record) {
    record = await PayloadUser.create({
      userId: userOid,
      billableMerchantId: String(billableMerchantId || ''),
      entityType: entityType || null,
      entityId: toObjectId(entityId),
      metadata: {},
      lastSyncedAt: ClockService.now(),
    });
  }
  return record;
}

async function initializePaymentMethodSetup({
  userId,
  billableMerchantId: billableMerchantIdInput,
  entityType,
  entityId,
  allowedMethods = 'CARD,ACH',
  req = null,
}) {
  ensurePayloadEnabled();
  const normalizedAllowedMethods = String(allowedMethods || 'CARD,ACH').toUpperCase().replace(/\s/g, '') === 'CARD'
    ? PAYLOAD_CARDS_SECTION_ALLOWED_METHODS
    : String(allowedMethods || 'CARD,ACH');
  const userOid = toObjectId(userId);
  const billableMerchantId = await resolveAuthoritativeBillableMerchantId({
    userId: userOid,
    entityType,
    entityId,
    billableMerchantIdInput,
  });

  if (!userOid || !billableMerchantId) {
    const err = new Error(billableMerchantUnavailableMessage({ entityType, entityId }));
    err.statusCode = 400;
    throw err;
  }

  const hoaOid = entityType === ENTITY_TYPE.HOA && entityId ? toObjectId(entityId) : null;
  const hoaCustomerContext = entityType === ENTITY_TYPE.HOA && entityId && payloadConfig.payload.hoaUnifiedOwnerWallet
    ? await resolveHoaPayloadWalletContextForActor(userOid, entityId)
    : null;

  const userContext = await ensurePayloadUserContext({
    userId: userOid,
    billableMerchantId,
    entityType,
    entityId: hoaOid || toObjectId(entityId),
  });
  const User = require('../../../../users/models/user.model');
  const user = await User.findById(userOid).select('firstName lastName email').lean();
  const payloadProcessingId = resolveHoaOwnerWalletProcessingId(hoaCustomerContext);
  if (hoaCustomerContext && !payloadProcessingId) {
    const err = new Error(billableMerchantUnavailableMessage({
      entityType,
      entityId,
      reason: resolveHoaOwnerWalletUnavailableReason(hoaCustomerContext),
    }));
    err.statusCode = 400;
    throw err;
  }

  const customerId = await ensurePayloadCustomerForUser({
    userId: userOid,
    billableMerchantId,
    primaryProcessingId: payloadProcessingId,
    hoaMerchantIds: hoaCustomerContext?.merchantIds || [],
    hoaId: hoaCustomerContext?.hoaId || null,
    user,
    payloadUserRecord: userContext,
  });

  const customerName = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()
    || user?.email
    || '';

  const session = await createPaymentMethodSession({
    merchantId: payloadProcessingId || billableMerchantId,
    customerId,
    allowedMethods: normalizedAllowedMethods,
    accountHolder: customerName || null,
  });

  const paymentMethodConfigId = `pmcfg_${billableMerchantId}_${String(userOid)}`;

  auditPayload({
    event: AUDIT_EVENTS.PAYMENT_METHOD_ADDED,
    entity: 'PayloadPaymentMethodConfig',
    entityId: paymentMethodConfigId,
    createdBy: userOid,
    after: {
      paymentMethodConfigId,
      billableMerchantId,
      allowedMethods: normalizedAllowedMethods,
      customerId,
      payloadProcessingId: payloadProcessingId || null,
      hoaProcessingMerchantIds: hoaCustomerContext?.merchantIds || [],
    },
    req,
  });

  return {
    paymentMethodConfigId,
    sessionKey: session.clientToken || session.sessionKey,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    billableMerchantId: String(billableMerchantId),
    primaryProcessingId: payloadProcessingId || hoaCustomerContext?.primaryProcessingId || '',
    hoaProcessingMerchantIds: hoaCustomerContext?.merchantIds || [],
    allowedMethods: normalizedAllowedMethods,
    clientToken: session.clientToken || session.sessionKey,
    customerId: String(customerId),
    intentId: session.intentId || '',
    payloadIntent: session.payloadIntent || null,
    customerName,
    customerEmail: user?.email || '',
    termsAndConditionsUrl: process.env.PAYLOAD_TERMS_URL || '',
  };
}

function extractBillingAddressDefaults(remote = {}) {
  const addr = remote?.billing_address || remote?.billingAddress || {};
  const street = String(addr.street_address || addr.streetAddress || '').trim();
  const city = String(addr.city || '').trim();
  const state = String(addr.state_province || addr.stateProvince || addr.state || '').trim();
  const postal = String(addr.postal_code || addr.postalCode || addr.zip || '').trim();
  const country = String(addr.country_code || addr.countryCode || 'US').trim().toUpperCase() || 'US';
  if (!street && !city && !state && !postal) return null;
  return {
    street_address: street,
    city,
    state_province: state,
    postal_code: postal,
    country_code: country,
  };
}

function buildPaymentMethodEditDefaults(remote = {}, localDisplay = {}) {
  const displayMeta = extractDisplayMetadata(remote || {});
  const bank = remote?.bank_account || remote?.bankAccount || {};
  const routing = String(
    bank.routing_number
    || bank.routingNumber
    || displayMeta.routingNumber
    || localDisplay.routingNumber
    || '',
  ).replace(/\D/g, '');
  const billingAddress = extractBillingAddressDefaults(remote);
  return {
    type: displayMeta.methodType || remote?.type || '',
    accountHolder: String(remote?.account_holder || remote?.accountHolder || displayMeta.holderName || localDisplay.holderName || '').trim(),
    accountType: String(bank.account_type || bank.accountType || displayMeta.accountType || localDisplay.accountType || '').trim().toLowerCase(),
    bankName: String(displayMeta.bankName || localDisplay.bankName || '').trim(),
    brand: String(displayMeta.brand || localDisplay.brand || '').trim(),
    last4: String(displayMeta.last4 || localDisplay.last4 || '').trim(),
    expMonth: displayMeta.expMonth ?? localDisplay.expMonth ?? null,
    expYear: displayMeta.expYear ?? localDisplay.expYear ?? null,
    routingLast4: routing ? routing.slice(-4) : String(localDisplay.routingNumber || '').replace(/\D/g, '').slice(-4),
    billingAddress: billingAddress || undefined,
  };
}

async function initializePaymentMethodEditSetup({
  userId,
  localMethodId,
  entityType,
  entityId,
  allowedMethods = 'CARD,ACH',
  req = null,
}) {
  ensurePayloadEnabled();
  const normalizedAllowedMethods = String(allowedMethods || 'CARD,ACH').toUpperCase().replace(/\s/g, '') === 'CARD'
    ? PAYLOAD_CARDS_SECTION_ALLOWED_METHODS
    : String(allowedMethods || 'CARD,ACH');
  const userOid = toObjectId(userId);
  // findOwner already resolves HOA wallet context once — reuse it below.
  const { doc: canonical, hoaContext: groupHoaContext } = await findOwnerPaymentMethodGroupForUser({
    userId: userOid,
    localMethodId,
    entityType,
    entityId,
  });

  const providerPaymentMethodId = String(canonical.providerPaymentMethodId || '').trim();
  if (!providerPaymentMethodId) {
    const err = new Error('This saved payment method cannot be edited. Remove it and add it again.');
    err.statusCode = 400;
    throw err;
  }

  const User = require('../../../../users/models/user.model');
  const [remotePm, billableMerchantId, user] = await Promise.all([
    client.getPaymentMethod(providerPaymentMethodId).catch((err) => {
      logger.warn('[PayloadPaymentMethod] Remote lookup failed during edit init', {
        providerPaymentMethodId,
        message: err.message,
      });
      return null;
    }),
    resolveAuthoritativeBillableMerchantId({
      userId: userOid,
      entityType,
      entityId,
      billableMerchantIdInput: canonical.billableMerchantId,
    }),
    User.findById(userOid).select('firstName lastName email').lean(),
  ]);

  if (!userOid || !billableMerchantId) {
    const err = new Error(billableMerchantUnavailableMessage({ entityType, entityId }));
    err.statusCode = 400;
    throw err;
  }

  const hoaOid = entityType === ENTITY_TYPE.HOA && entityId ? toObjectId(entityId) : null;
  const hoaCustomerContext = groupHoaContext
    || (entityType === ENTITY_TYPE.HOA && entityId && payloadConfig.payload.hoaUnifiedOwnerWallet
      ? await resolveHoaPayloadWalletContextForActor(userOid, entityId)
      : null);

  const userContext = await ensurePayloadUserContext({
    userId: userOid,
    billableMerchantId,
    entityType,
    entityId: hoaOid || toObjectId(entityId),
  });
  const payloadProcessingId = resolveHoaOwnerWalletProcessingId(hoaCustomerContext);
  if (hoaCustomerContext && !payloadProcessingId) {
    const err = new Error(billableMerchantUnavailableMessage({
      entityType,
      entityId,
      reason: resolveHoaOwnerWalletUnavailableReason(hoaCustomerContext),
    }));
    err.statusCode = 400;
    throw err;
  }

  const remoteCustomerId = String(remotePm?.customer_id || remotePm?.customerId || '').trim();
  const cachedCustomerId = String(userContext?.metadata?.payloadCustomerId || '').trim();
  // Skip extra Payload GET /customers when the payment method already names the customer.
  let customerId = '';
  if (remoteCustomerId && cachedCustomerId && remoteCustomerId === cachedCustomerId) {
    customerId = cachedCustomerId;
  } else if (remoteCustomerId && !cachedCustomerId) {
    userContext.metadata = {
      ...(userContext.metadata || {}),
      payloadCustomerId: remoteCustomerId,
    };
    userContext.markModified('metadata');
    await userContext.save();
    customerId = remoteCustomerId;
  } else {
    customerId = await ensurePayloadCustomerForUser({
      userId: userOid,
      billableMerchantId,
      primaryProcessingId: payloadProcessingId,
      hoaMerchantIds: hoaCustomerContext?.merchantIds || [],
      hoaId: hoaCustomerContext?.hoaId || null,
      user,
      payloadUserRecord: userContext,
    });
  }

  const editDefaults = buildPaymentMethodEditDefaults(remotePm || {}, canonical.display || {});
  const customerName = editDefaults.accountHolder
    || [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim()
    || user?.email
    || '';

  const achOnly = String(normalizedAllowedMethods).toUpperCase().replace(/\s/g, '') === 'ACH';
  const bankAccountDefaults = achOnly
    ? {
      account_class: 'personal',
      ...(editDefaults.accountType ? { account_type: editDefaults.accountType } : {}),
    }
    : null;

  const session = await createPaymentMethodSession({
    merchantId: payloadProcessingId || billableMerchantId,
    customerId,
    paymentMethodId: providerPaymentMethodId,
    allowedMethods: normalizedAllowedMethods,
    accountHolder: customerName || null,
    bankAccountDefaults,
    billingAddressDefaults: editDefaults.billingAddress || null,
    paymentMethodType: achOnly ? 'bank_account' : 'card',
  });

  const paymentMethodConfigId = canonical.paymentMethodConfigId
    || `pmcfg_${billableMerchantId}_${String(userOid)}`;

  auditPayload({
    event: AUDIT_EVENTS.PAYMENT_METHOD_STATUS_UPDATED,
    entity: 'PayloadPaymentMethod',
    entityId: canonical._id,
    createdBy: userOid,
    after: {
      mode: 'edit',
      providerPaymentMethodId,
      paymentMethodConfigId,
    },
    req,
  });

  return {
    mode: 'edit',
    editLocalMethodId: String(canonical._id),
    providerPaymentMethodId,
    paymentMethodConfigId,
    sessionKey: session.clientToken || session.sessionKey,
    sessionId: session.sessionId,
    expiresAt: session.expiresAt,
    billableMerchantId: String(billableMerchantId),
    primaryProcessingId: hoaCustomerContext?.primaryProcessingId || String(billableMerchantId),
    allowedMethods: normalizedAllowedMethods,
    clientToken: session.clientToken || session.sessionKey,
    customerId: String(customerId),
    intentId: session.intentId || '',
    payloadIntent: session.payloadIntent || null,
    customerName,
    customerEmail: user?.email || '',
    termsAndConditionsUrl: process.env.PAYLOAD_TERMS_URL || '',
    editDefaults,
  };
}

async function registerPaymentMethodFromComponent({
  userId,
  paymentMethodId,
  paymentMethodConfigId,
  billableMerchantId: billableMerchantIdInput,
  entityType,
  entityId,
  req = null,
}) {
  ensurePayloadEnabled();
  const userOid = toObjectId(userId);
  if (!userOid || !paymentMethodId) {
    const err = new Error('Payment method id is required.');
    err.statusCode = 400;
    throw err;
  }

  let remote = null;
  try {
    remote = await client.getPaymentMethod(paymentMethodId);
  } catch (err) {
    logger.warn('[PayloadPaymentMethod] Remote lookup failed during register', { paymentMethodId, message: err.message });
  }

  let billableMerchantId = await resolveAuthoritativeBillableMerchantId({
    userId: userOid,
    entityType,
    entityId,
    billableMerchantIdInput,
  });

  const displayMeta = extractDisplayMetadata(remote || {});
  const type = displayMeta.methodType || PAYMENT_METHOD_TYPE.CARD;
  const status = String(remote?.status || PAYMENT_METHOD_STATUS.ACTIVE).toUpperCase();
  const remoteCustomerId = String(
    remote?.customer_id
    || remote?.customerId
    || ''
  ).trim();

  const hoaRegisterContext = entityType === ENTITY_TYPE.HOA && entityId && payloadConfig.payload.hoaUnifiedOwnerWallet
    ? await resolveHoaPayloadWalletContextForActor(userOid, entityId)
    : null;

  if (remote && billableMerchantId && !isHoaOwnerPayloadScopeKey(billableMerchantId)) {
    const remoteAccountId = String(
      remote?.account_id
      || remote?.processing_id
      || remote?.processingId
      || ''
    ).trim();
    const remoteCustomerId = String(remote?.customer_id || remote?.customerId || '').trim();
    if (
      remoteAccountId
      && remoteCustomerId
      && remoteAccountId === remoteCustomerId
    ) {
      // Customer-scoped payment method (Payload payment_method_form + customer_id).
    } else if (remoteAccountId && remoteAccountId !== String(billableMerchantId)) {
      const err = new Error(
        'This bank account was saved under a different HOA business account. Close the form and add your bank again from Payment Settings for your community.'
      );
      err.statusCode = 400;
      throw err;
    }
  }

  const existing = await PayloadPaymentMethod.findOne({
    providerPaymentMethodId: String(paymentMethodId),
  });

  if (existing) {
    if (String(existing.userId) !== String(userOid)) {
      const err = new Error('Payment method belongs to another user.');
      err.statusCode = 403;
      throw err;
    }
    existing.display = buildDisplayPayload(displayMeta);
    existing.type = type || existing.type;
    existing.status = status || existing.status;
    existing.lastWebhookAt = ClockService.now();
    if (hoaRegisterContext?.hoaId) {
      existing.entityType = ENTITY_TYPE.HOA;
      existing.entityId = toObjectId(hoaRegisterContext.hoaId);
      existing.billableMerchantId = hoaRegisterContext.scopeKey;
      existing.metadata = {
        ...(existing.metadata || {}),
        ...buildHoaOwnerPaymentMethodMetadataPatch(hoaRegisterContext.merchantIds),
      };
      existing.markModified('metadata');
    }
    if (remoteCustomerId) {
      existing.metadata = {
        ...(existing.metadata || {}),
        payloadCustomerId: remoteCustomerId,
      };
      existing.markModified('metadata');
    }
    await existing.save();
    if (hoaRegisterContext?.hoaId) {
      const siblings = await PayloadPaymentMethod.find({
        userId: userOid,
        isDeleted: { $ne: true },
      });
      await consolidateHoaOwnerPaymentMethodDuplicates({
        userId: userOid,
        hoaId: hoaRegisterContext.hoaId,
        methods: siblings,
        merchantIds: hoaRegisterContext.merchantIds,
      });
    }
    return sanitizePaymentMethod(existing);
  }

  if (hoaRegisterContext?.hoaId) {
    const orFilters = buildHoaOwnerPaymentMethodListOrFilters(entityId, hoaRegisterContext);
    const identityKey = buildOwnerPaymentMethodIdentityKey({
      type,
      display: buildDisplayPayload(displayMeta),
    });
    if (orFilters.length > 0 && identityKey) {
      const siblings = await PayloadPaymentMethod.find({
        userId: userOid,
        isDeleted: { $ne: true },
        $or: orFilters,
      });
      const duplicateLocal = siblings.find(
        (row) => buildOwnerPaymentMethodIdentityKey(sanitizePaymentMethod(row)) === identityKey,
      );
      if (duplicateLocal) {
        const previousProviderId = String(duplicateLocal.providerPaymentMethodId || '').trim();
        if (previousProviderId && previousProviderId !== String(paymentMethodId)) {
          await deactivateRemoteOwnerPaymentMethod(previousProviderId);
        }
        duplicateLocal.providerPaymentMethodId = String(paymentMethodId);
        duplicateLocal.paymentMethodConfigId = paymentMethodConfigId
          || duplicateLocal.paymentMethodConfigId
          || remote?.payment_method_config_id
          || '';
        duplicateLocal.entityType = ENTITY_TYPE.HOA;
        duplicateLocal.entityId = toObjectId(hoaRegisterContext.hoaId);
        duplicateLocal.billableMerchantId = hoaRegisterContext.scopeKey;
        duplicateLocal.display = buildDisplayPayload(displayMeta);
        duplicateLocal.type = type || duplicateLocal.type;
        duplicateLocal.status = status || duplicateLocal.status;
        duplicateLocal.metadata = {
          ...(duplicateLocal.metadata || {}),
          ...buildHoaOwnerPaymentMethodMetadataPatch(hoaRegisterContext.merchantIds),
          ...(remoteCustomerId ? { payloadCustomerId: remoteCustomerId } : {}),
        };
        duplicateLocal.markModified('metadata');
        duplicateLocal.lastWebhookAt = ClockService.now();
        await duplicateLocal.save();
        await consolidateHoaOwnerPaymentMethodDuplicates({
          userId: userOid,
          hoaId: hoaRegisterContext.hoaId,
          methods: await PayloadPaymentMethod.find({ userId: userOid, isDeleted: { $ne: true } }),
          merchantIds: hoaRegisterContext.merchantIds,
        });
        return sanitizePaymentMethod(duplicateLocal);
      }
    }
  }

  const doc = await PayloadPaymentMethod.create({
    userId: userOid,
    providerPaymentMethodId: String(paymentMethodId),
    paymentMethodConfigId: paymentMethodConfigId || remote?.payment_method_config_id || '',
    billableMerchantId: hoaRegisterContext?.scopeKey || billableMerchantId || remote?.billable_merchant_id || '',
    entityType: hoaRegisterContext?.hoaId ? ENTITY_TYPE.HOA : null,
    entityId: hoaRegisterContext?.hoaId ? toObjectId(hoaRegisterContext.hoaId) : null,
    type,
    status,
    display: buildDisplayPayload(displayMeta),
    metadata: {
      propmv_registered_at: ClockService.now(),
      ...(remoteCustomerId ? { payloadCustomerId: remoteCustomerId } : {}),
      ...(hoaRegisterContext?.merchantIds
        ? buildHoaOwnerPaymentMethodMetadataPatch(hoaRegisterContext.merchantIds)
        : {}),
    },
    lastWebhookAt: ClockService.now(),
  });

  auditPayload({
    event: AUDIT_EVENTS.PAYMENT_METHOD_ADDED,
    entity: 'PayloadPaymentMethod',
    entityId: doc._id,
    createdBy: userOid,
    after: sanitizePaymentMethod(doc),
    req,
  });

  if (hoaRegisterContext?.hoaId) {
    const siblings = await PayloadPaymentMethod.find({
      userId: userOid,
      isDeleted: { $ne: true },
    });
    await consolidateHoaOwnerPaymentMethodDuplicates({
      userId: userOid,
      hoaId: hoaRegisterContext.hoaId,
      methods: siblings,
      merchantIds: hoaRegisterContext.merchantIds,
    });
  }

  return sanitizePaymentMethod(doc);
}

async function enrichListedPaymentMethodDisplays(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  // Backfill brand/last4 from Payload when local display was stored with wrong field names.
  return Promise.all(rows.map((doc) => refreshPaymentMethodDisplayFromRemote(doc)));
}

async function listUserPaymentMethods(userId, { entityType, entityId } = {}) {
  const userOid = toObjectId(userId);
  if (!userOid) return [];

  const query = {
    userId: userOid,
    isDeleted: { $ne: true },
    status: { $in: [PAYMENT_METHOD_STATUS.ACTIVE, PAYMENT_METHOD_STATUS.CREATED] },
  };

  if (entityType === ENTITY_TYPE.HOA && entityId) {
    if (payloadConfig.payload.hoaUnifiedOwnerWallet) {
      const ctx = await resolveHoaPayloadWalletContextForActor(userOid, entityId);
      const orFilters = buildHoaOwnerPaymentMethodListOrFilters(entityId, ctx);
      if (orFilters.length > 0) {
        query.$or = orFilters;
      }
    } else {
      const scopedMerchantId = await resolveBillableMerchantForUser({
        userId: userOid,
        entityType,
        entityId,
      });
      if (scopedMerchantId) {
        query.billableMerchantId = String(scopedMerchantId);
      }
    }
  }

  let rows = await PayloadPaymentMethod.find(query).sort({ isDefault: -1, createdAt: -1 });

  if (entityType === ENTITY_TYPE.HOA && entityId && payloadConfig.payload.hoaUnifiedOwnerWallet) {
    const ctx = await resolveHoaPayloadWalletContextForActor(userOid, entityId);
    await consolidateHoaOwnerPaymentMethodDuplicates({
      userId: userOid,
      hoaId: entityId,
      methods: rows,
      merchantIds: ctx.merchantIds,
    });
    rows = await PayloadPaymentMethod.find(query).sort({ isDefault: -1, createdAt: -1 });
    rows = await enrichListedPaymentMethodDisplays(rows);
    const sanitized = rows.map(sanitizePaymentMethod);
    return dedupeHoaOwnerPaymentMethodsForList(sanitized, {
      hoaId: entityId,
      merchantIds: ctx.merchantIds,
    });
  }

  rows = await enrichListedPaymentMethodDisplays(rows);
  return rows.map(sanitizePaymentMethod);
}

async function applyPaymentMethodWebhookUpdate({ paymentMethodId, status, remotePayload = null }) {
  const doc = await PayloadPaymentMethod.findOne({
    providerPaymentMethodId: String(paymentMethodId),
    isDeleted: { $ne: true },
  });

  if (!doc && remotePayload) {
    const metadataUserId = remotePayload?.metadata?.propmv_user_id;
    const userOid = toObjectId(metadataUserId);
    if (!userOid) return null;

    const displayMeta = extractDisplayMetadata(remotePayload);
    const created = await PayloadPaymentMethod.create({
      userId: userOid,
      providerPaymentMethodId: String(paymentMethodId),
      paymentMethodConfigId: remotePayload?.payment_method_config_id || '',
      billableMerchantId: remotePayload?.billable_merchant_id || '',
      type: displayMeta.methodType || PAYMENT_METHOD_TYPE.CARD,
      status: String(status || remotePayload?.status || PAYMENT_METHOD_STATUS.ACTIVE).toUpperCase(),
      display: buildDisplayPayload(displayMeta),
      metadata: { source: 'webhook' },
      lastWebhookAt: ClockService.now(),
    });

    auditPayload({
      event: AUDIT_EVENTS.PAYMENT_METHOD_STATUS_UPDATED,
      entity: 'PayloadPaymentMethod',
      entityId: created._id,
      createdBy: userOid,
      after: sanitizePaymentMethod(created),
    });

    return created;
  }

  if (!doc) return null;

  const before = sanitizePaymentMethod(doc);
  doc.status = String(status || doc.status).toUpperCase();
  if (remotePayload) {
    const displayMeta = extractDisplayMetadata(remotePayload);
    doc.display = buildDisplayPayload({
      brand: displayMeta.brand || doc.display?.brand || '',
      last4: displayMeta.last4 || doc.display?.last4 || '',
      expMonth: displayMeta.expMonth ?? doc.display?.expMonth ?? null,
      expYear: displayMeta.expYear ?? doc.display?.expYear ?? null,
      accountType: displayMeta.accountType || doc.display?.accountType || '',
      bankName: displayMeta.bankName || doc.display?.bankName || '',
      holderName: displayMeta.holderName || doc.display?.holderName || '',
      routingNumber: displayMeta.routingNumber || doc.display?.routingNumber || '',
      fingerprint: displayMeta.fingerprint || doc.display?.fingerprint || '',
    });
    doc.type = displayMeta.methodType || doc.type;
  }
  doc.lastWebhookAt = ClockService.now();
  await doc.save();

  auditPayload({
    event: AUDIT_EVENTS.PAYMENT_METHOD_STATUS_UPDATED,
    entity: 'PayloadPaymentMethod',
    entityId: doc._id,
    createdBy: doc.userId,
    before,
    after: sanitizePaymentMethod(doc),
  });

  return doc;
}

async function assertOwnerCanUseHoaPaymentScope(userId, entityType, entityId) {
  if (entityType !== ENTITY_TYPE.HOA || !entityId) return;
  const hoaIdStr = String(entityId).trim();
  if (!toObjectId(hoaIdStr)) {
    const err = new Error('A valid HOA community id is required.');
    err.statusCode = 400;
    throw err;
  }
  const { assertUserCanAccessHoaCommunity } = require('../../../../../../portals/hoa-board/modules/hoa/helpers/hoaOnboardingStatus.helper');
  if (typeof assertUserCanAccessHoaCommunity !== 'function') {
    const err = new Error('HOA access validation is unavailable.');
    err.statusCode = 500;
    throw err;
  }
  await assertUserCanAccessHoaCommunity(userId, hoaIdStr);
}

async function resolveAuthoritativeBillableMerchantId({
  userId,
  entityType,
  entityId,
  billableMerchantIdInput,
}) {
  await assertOwnerCanUseHoaPaymentScope(userId, entityType, entityId);

  const resolved = await resolveBillableMerchantForUser({
    userId,
    entityType,
    entityId,
  });

  if (!resolved) {
    const err = new Error(billableMerchantUnavailableMessage({ entityType, entityId }));
    err.statusCode = 400;
    throw err;
  }

  if (entityType === ENTITY_TYPE.HOA && entityId && payloadConfig.payload.hoaUnifiedOwnerWallet) {
    const ctx = await resolveHoaPayloadWalletContextForActor(userId, entityId);
    if (!ctx.scopeKey || !resolveHoaOwnerWalletProcessingId(ctx)) {
      const err = new Error(billableMerchantUnavailableMessage({
        entityType,
        entityId,
        reason: resolveHoaOwnerWalletUnavailableReason(ctx),
      }));
      err.statusCode = 400;
      throw err;
    }
    if (
      billableMerchantIdInput
      && !isHoaOwnerBillableMerchantInputValid(billableMerchantIdInput, ctx)
    ) {
      const err = new Error(
        'Payment method setup expired or was started for a different HOA community. Please close the form and add your bank again.'
      );
      err.statusCode = 400;
      throw err;
    }
    return ctx.scopeKey;
  }

  if (
    billableMerchantIdInput
    && String(billableMerchantIdInput) !== String(resolved)
  ) {
    const err = new Error(
      'Payment method setup expired or was started for a different HOA business account. Please close the form and add your bank again.'
    );
    err.statusCode = 400;
    throw err;
  }

  return String(resolved);
}

async function resolvePayloadUserRecordForPayin({ userId, method, hoaId }) {
  const userOid = toObjectId(userId);
  if (!userOid || !method) return null;

  if (hoaId && payloadConfig.payload.hoaUnifiedOwnerWallet) {
    const scopeKey = buildHoaOwnerPayloadScopeKey(hoaId);
    const scoped = await PayloadUser.findOne({
      userId: userOid,
      billableMerchantId: scopeKey,
    });
    if (scoped) return scoped;
  }

  const legacyScope = String(method.billableMerchantId || '').trim();
  if (!legacyScope || isHoaOwnerPayloadScopeKey(legacyScope)) return null;

  return PayloadUser.findOne({
    userId: userOid,
    billableMerchantId: legacyScope,
  });
}

async function deactivateRemoteOwnerPaymentMethod(providerPaymentMethodId) {
  const providerId = String(providerPaymentMethodId || '').trim();
  if (!providerId) return;

  try {
    await client.deletePaymentMethod(providerId);
    return;
  } catch (err) {
    if (err.statusCode !== 404 && err.statusCode !== 405) {
      logger.warn('[PayloadPaymentMethod] Payload delete payment method failed; trying inactive', {
        providerPaymentMethodId: providerId,
        message: err.message,
      });
    }
  }

  try {
    await client.updatePaymentMethod(providerId, { status: 'inactive' });
  } catch (err) {
    logger.warn('[PayloadPaymentMethod] Payload inactive update failed for payment method', {
      providerPaymentMethodId: providerId,
      message: err.message,
    });
  }
}

async function findOwnerPaymentMethodGroupForUser({
  userId,
  localMethodId,
  entityType,
  entityId,
}) {
  const userOid = toObjectId(userId);
  const methodOid = toObjectId(localMethodId);
  if (!userOid || !methodOid) {
    const err = new Error('Invalid payment method reference.');
    err.statusCode = 400;
    throw err;
  }

  const doc = await PayloadPaymentMethod.findOne({
    _id: methodOid,
    userId: userOid,
    isDeleted: { $ne: true },
  });
  if (!doc) {
    const err = new Error('Payload payment method not found.');
    err.statusCode = 404;
    throw err;
  }

  if (entityType === ENTITY_TYPE.HOA && entityId) {
    await assertOwnerCanUseHoaPaymentScope(userId, entityType, entityId);
    const ctx = await resolveHoaPayloadWalletContextForActor(userOid, entityId);
    const orFilters = buildHoaOwnerPaymentMethodListOrFilters(entityId, ctx);
    const siblings = orFilters.length
      ? await PayloadPaymentMethod.find({
        userId: userOid,
        isDeleted: { $ne: true },
        $or: orFilters,
      })
      : [doc];

    const identityKey = buildOwnerPaymentMethodIdentityKey(sanitizePaymentMethod(doc));
    const group = siblings.filter(
      (row) => buildOwnerPaymentMethodIdentityKey(sanitizePaymentMethod(row)) === identityKey,
    );
    return { doc, group: group.length ? group : [doc], hoaContext: ctx };
  }

  return { doc, group: [doc], hoaContext: null };
}

async function deletePaymentMethodForUser({
  userId,
  localMethodId,
  entityType,
  entityId,
  req = null,
}) {
  ensurePayloadEnabled();
  const { doc, group } = await findOwnerPaymentMethodGroupForUser({
    userId,
    localMethodId,
    entityType,
    entityId,
  });

  const providerIds = [...new Set(
    group.map((row) => String(row.providerPaymentMethodId || '').trim()).filter(Boolean),
  )];

  for (const providerId of providerIds) {
    await deactivateRemoteOwnerPaymentMethod(providerId);
  }

  const localIds = group.map((row) => row._id);
  await PayloadPaymentMethod.updateMany(
    { _id: { $in: localIds }, userId: doc.userId },
    { $set: { isDeleted: true, deletedAt: ClockService.now(), status: PAYMENT_METHOD_STATUS.DEACTIVATED } },
  );

  auditPayload({
    event: AUDIT_EVENTS.PAYMENT_METHOD_STATUS_UPDATED,
    entity: 'PayloadPaymentMethod',
    entityId: doc._id,
    createdBy: doc.userId,
    before: sanitizePaymentMethod(doc),
    after: { deleted: true, providerPaymentMethodIds: providerIds },
    req,
  });

  try {
    const { disableAutopayIfUsingPaymentMethod } = require('./payloadAutopay.service');
    await disableAutopayIfUsingPaymentMethod({
      userId: doc.userId,
      localMethodIds: localIds,
      providerPaymentMethodIds: providerIds,
    });
  } catch (autopayErr) {
    logger.warn('[PayloadPaymentMethod] Autopay disable after delete failed', {
      userId: String(doc.userId),
      message: autopayErr.message,
    });
  }

  return { deleted: true, removedCount: localIds.length };
}

async function updatePaymentMethodForUser({
  userId,
  localMethodId,
  description,
  isDefault,
  billingAddress,
  entityType,
  entityId,
  req = null,
}) {
  ensurePayloadEnabled();
  const { doc, group } = await findOwnerPaymentMethodGroupForUser({
    userId,
    localMethodId,
    entityType,
    entityId,
  });

  const providerId = String(doc.providerPaymentMethodId || '').trim();
  if (!providerId) {
    const err = new Error('Payload payment method is missing provider id.');
    err.statusCode = 400;
    throw err;
  }

  const remotePatch = {};
  if (description != null) remotePatch.description = String(description).trim().slice(0, 200);
  if (typeof isDefault === 'boolean') remotePatch.default_payment_method = isDefault;
  if (billingAddress && typeof billingAddress === 'object') {
    remotePatch.billing_address = billingAddress;
  }

  if (Object.keys(remotePatch).length > 0) {
    try {
      await client.updatePaymentMethod(providerId, remotePatch);
    } catch (err) {
      logger.warn('[PayloadPaymentMethod] Payload update payment method failed', {
        providerPaymentMethodId: providerId,
        message: err.message,
      });
      const updateErr = new Error('Unable to update payment method with Payload.');
      updateErr.statusCode = err.statusCode || 502;
      throw updateErr;
    }
  }

  if (typeof isDefault === 'boolean') {
    if (isDefault) {
      await PayloadPaymentMethod.updateMany(
        { userId: doc.userId, isDeleted: { $ne: true }, _id: { $ne: doc._id } },
        { $set: { isDefault: false } },
      );
    }
    doc.isDefault = isDefault;
  }

  if (description != null) {
    doc.metadata = {
      ...(doc.metadata || {}),
      ownerDescription: String(description).trim().slice(0, 200),
    };
    doc.markModified('metadata');
  }

  doc.lastWebhookAt = ClockService.now();
  await doc.save();

  if (typeof isDefault === 'boolean' && isDefault && group.length > 1) {
    await PayloadPaymentMethod.updateMany(
      { _id: { $in: group.map((row) => row._id).filter((id) => String(id) !== String(doc._id)) } },
      { $set: { isDefault: false } },
    );
  }

  auditPayload({
    event: AUDIT_EVENTS.PAYMENT_METHOD_STATUS_UPDATED,
    entity: 'PayloadPaymentMethod',
    entityId: doc._id,
    createdBy: doc.userId,
    after: sanitizePaymentMethod(doc),
    req,
  });

  return sanitizePaymentMethod(doc);
}

async function resolveBillableMerchantForUser({ userId, entityType, entityId, businessId }) {
  if (entityType === ENTITY_TYPE.HOA && entityId) {
    await assertOwnerCanUseHoaPaymentScope(userId, entityType, entityId);
    if (payloadConfig.payload.hoaUnifiedOwnerWallet) {
      const ctx = await resolveHoaPayloadWalletContextForActor(userId, entityId);
      return ctx.scopeKey || '';
    }
    const { resolveHoaBoardMemberIdsForOwner } = require('../utils/payloadHoaOwnerBoardMemberScope.util');
    const boardMemberIds = userId
      ? await resolveHoaBoardMemberIdsForOwner(userId, entityId)
      : undefined;
    const merchantId = await resolvePayloadHoaOwnerBillableMerchantId(entityId, {
      findActiveBillableMerchantId,
      boardMemberIds,
    });
    if (merchantId) return merchantId;
    return '';
  }

  if (entityType && businessId) {
    const entityQuery = buildEntityBillableMerchantQuery({ entityType, businessId, toObjectId });
    const merchantId = await findActiveBillableMerchantId(entityQuery);
    if (merchantId) return merchantId;
  }

  return '';
}

module.exports = {
  initializePaymentMethodSetup,
  initializePaymentMethodEditSetup,
  registerPaymentMethodFromComponent,
  deletePaymentMethodForUser,
  updatePaymentMethodForUser,
  listUserPaymentMethods,
  applyPaymentMethodWebhookUpdate,
  resolveBillableMerchantForUser,
  resolvePayloadUserRecordForPayin,
  sanitizePaymentMethod,
  ensurePayloadCustomerForUser,
  ensurePayloadUserContext,
  isActiveHoaBoardMember,
  resolveHoaPayloadWalletContextForActor,
  resolveHoaOwnerWalletUnavailableReason,
  /** Test/helper: maps Payload API payment_method fields → local display. */
  extractDisplayMetadata,
};
