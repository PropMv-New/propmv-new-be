/**
 * ------------------------------------------------------------------
 * File: billingSettings.service.js
 * Module: Billing Settings Module
 *
 * Purpose:
 * Core business logic layer module coordinating data persistence, validation, and calculations.
 *
 * Used By:
 * billingSettings.controller
 * ------------------------------------------------------------------
 */
const mongoose = require('mongoose');
const BillingSettings = require('../model/billingSettings.model');

const DEFAULT_TRANSACTION_FEES = {
  bankTransfer: { feeAmount: 2, paidBy: 'payer' },
  card: { feePercent: 2.99, paidBy: 'payer' },
};

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/**
 * normalize Paid By
 *
 * Performs logic operations for normalizePaidBy.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function normalizePaidBy(value) {
  return value === 'operator' ? 'operator' : 'payer';
}

/**
 * normalize Transaction Fees
 *
 * Performs logic operations for normalizeTransactionFees.
 *
 * @param raw - Request/input argument
 * @returns Operations result
 */
function normalizeTransactionFees(raw = {}) {
  return {
    bankTransfer: {
      feeAmount: Number(raw.bankTransfer?.feeAmount ?? DEFAULT_TRANSACTION_FEES.bankTransfer.feeAmount),
      paidBy: normalizePaidBy(raw.bankTransfer?.paidBy),
    },
    card: {
      feePercent: Number(raw.card?.feePercent ?? DEFAULT_TRANSACTION_FEES.card.feePercent),
      paidBy: normalizePaidBy(raw.card?.paidBy),
    },
  };
}

/**
 * normalize Billing Settings
 *
 * Performs logic operations for normalizeBillingSettings.
 *
 * @param doc - Request/input argument
 * @returns Operations result
 */
function normalizeBillingSettings(doc) {
  return {
    transactionFees: normalizeTransactionFees(doc?.transactionFees),
    hoaId: doc?.hoaId ? String(doc.hoaId) : null,
    operatorUserId: doc?.operatorUserId ? String(doc.operatorUserId) : null,
    updatedAt: doc?.updatedAt || null,
  };
}

async function resolveHoaIdForBilling(userId, hoaContext) {
  if (hoaContext?.hoaId) return String(hoaContext.hoaId);

  const safeUserId = toObjectId(userId);
  if (!safeUserId) throw new Error('Invalid userId for billing settings lookup');

  const HOAMembership = require('../../../../portals/hoa-board/modules/hoa/model/hoaMembership.model');
  const membership = await HOAMembership.findOne({ userId: safeUserId, status: 'active' }).lean();
  if (membership?.hoaId) return String(membership.hoaId);

  throw new Error('Active HOA community is required for billing settings');
}

async function getHoaBillingSettings(userId, hoaContext) {
  const hoaId = await resolveHoaIdForBilling(userId, hoaContext);
  const safeHoaId = toObjectId(hoaId);
  if (!safeHoaId) throw new Error('Invalid hoaId resolved for billing settings');
  const doc = await BillingSettings.findOne({ hoaId: safeHoaId }).lean();
  return { ...normalizeBillingSettings(doc), hoaId };
}

async function upsertHoaBillingSettings(userId, hoaContext, payload = {}) {
  const hoaId = await resolveHoaIdForBilling(userId, hoaContext);
  const safeHoaId = toObjectId(hoaId);
  if (!safeHoaId) throw new Error('Invalid hoaId resolved for billing settings');
  const safeUserId = toObjectId(userId);
  if (!safeUserId) throw new Error('Invalid userId for billing settings');
  const fees = normalizeTransactionFees(payload.transactionFees);

  const doc = await BillingSettings.findOneAndUpdate(
    { hoaId: safeHoaId },
    {
      $set: {
        hoaId: safeHoaId,
        transactionFees: fees,
        updatedBy: safeUserId,
      },
      $unset: { operatorUserId: '' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return { ...normalizeBillingSettings(doc), hoaId };
}

async function getOperatorBillingSettings(userId) {
  const safeUserId = toObjectId(userId);
  if (!safeUserId) throw new Error('Invalid userId for billing settings');
  const doc = await BillingSettings.findOne({ operatorUserId: safeUserId }).lean();
  return { ...normalizeBillingSettings(doc), operatorUserId: String(userId) };
}

async function upsertOperatorBillingSettings(userId, payload = {}) {
  const safeUserId = toObjectId(userId);
  if (!safeUserId) throw new Error('Invalid userId for billing settings');
  const fees = normalizeTransactionFees(payload.transactionFees);

  const doc = await BillingSettings.findOneAndUpdate(
    { operatorUserId: safeUserId },
    {
      $set: {
        operatorUserId: safeUserId,
        transactionFees: fees,
        updatedBy: safeUserId,
      },
      $unset: { hoaId: '' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return { ...normalizeBillingSettings(doc), operatorUserId: String(userId) };
}

async function getEffectiveBillingSettingsForProperty(propertyId) {
  const safePropertyId = toObjectId(propertyId);
  if (!safePropertyId) return normalizeBillingSettings();

  const Property = require('../../../../portals/hoa-board/modules/property/model/property.model');
  const property = await Property.findOne({
    _id: safePropertyId,
    isDeleted: { $ne: true },
  })
    .select('hoaId landlord_id createdBy')
    .lean();

  if (!property) return normalizeBillingSettings();

  if (property.hoaId) {
    const safeHoaId = toObjectId(property.hoaId);
    if (!safeHoaId) return normalizeBillingSettings();
    const doc = await BillingSettings.findOne({ hoaId: safeHoaId }).lean();
    return normalizeBillingSettings(doc);
  }

  const operatorId = property.landlord_id || property.createdBy;
  if (operatorId) {
    const safeOperatorId = toObjectId(operatorId);
    if (!safeOperatorId) return normalizeBillingSettings();
    const doc = await BillingSettings.findOne({ operatorUserId: safeOperatorId }).lean();
    return normalizeBillingSettings(doc);
  }

  return normalizeBillingSettings();
}

/**
 * calc Processing Fee Amount
 *
 * Performs logic operations for calcProcessingFeeAmount.
 *
 * @param amount - Request/input argument
 * @param method - Request/input argument
 * @param settings - Request/input argument
 * @returns Operations result
 */
function calcProcessingFeeAmount(amount, method, settings = normalizeBillingSettings()) {
  const fees = settings.transactionFees || DEFAULT_TRANSACTION_FEES;
  const safeAmount = Number(amount) || 0;
  if (safeAmount <= 0) return 0;

  if (method === 'card' || method === 'credit_card') {
    if (fees.card.paidBy === 'operator') return 0;
    return Number((safeAmount * (fees.card.feePercent / 100)).toFixed(2));
  }

  if (fees.bankTransfer.paidBy === 'operator') return 0;
  return Number(fees.bankTransfer.feeAmount || 0);
}

module.exports = {
  DEFAULT_TRANSACTION_FEES,
  normalizeBillingSettings,
  normalizeTransactionFees,
  getHoaBillingSettings,
  upsertHoaBillingSettings,
  getOperatorBillingSettings,
  upsertOperatorBillingSettings,
  getEffectiveBillingSettingsForProperty,
  calcProcessingFeeAmount,
};
