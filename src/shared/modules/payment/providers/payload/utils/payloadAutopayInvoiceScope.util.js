'use strict';

/**
 * Autopay invoice ownership scope for HOA Owners.
 *
 * Visibility for Owner Invoices uses property universe via
 * resolveHoaOwnerInvoicePropertyIds. Autopay charging reuses that universe
 * AND requires tenants: ownerOid so one Owner cannot charge another's invoice
 * merely by sharing a property/HOA.
 */

const mongoose = require('mongoose');
const { resolveHoaOwnerInvoicePropertyIds } = require('../../../../../../common/helpers/hoaPropertyScope');

function toObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (value && typeof value === 'object' && value._bsontype === 'ObjectId') {
    const asString = String(value);
    if (mongoose.Types.ObjectId.isValid(asString) && asString.length === 24) {
      return new mongoose.Types.ObjectId(asString);
    }
    return null;
  }
  const raw = value && typeof value === 'object' && value._id != null ? value._id : value;
  const str = String(raw ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/**
 * Schema-correct payer id from invoice.tenants[] entries.
 * HOA invoices store ObjectId refs (not { userId }). Populated user docs are supported.
 * Does not rely on BSON ObjectId._id self-reference quirks.
 *
 * @param {*} tenant
 * @returns {string}
 */
function normalizeInvoiceTenantUserId(tenant) {
  if (tenant == null || tenant === '') return '';

  if (tenant instanceof mongoose.Types.ObjectId || tenant._bsontype === 'ObjectId') {
    return String(tenant);
  }

  if (typeof tenant === 'string' || typeof tenant === 'number') {
    return String(tenant).trim();
  }

  if (typeof tenant === 'object') {
    if (tenant.userId != null && tenant.userId !== '') {
      return normalizeInvoiceTenantUserId(tenant.userId);
    }
    // Populated User document: use _id only when this is a plain/doc object, not a raw ObjectId
    // (raw ObjectId handled above).
    if (Object.prototype.hasOwnProperty.call(tenant, '_id') && tenant._id != null) {
      return normalizeInvoiceTenantUserId(tenant._id);
    }
  }

  return '';
}

function collectInvoiceTenantUserIds(tenants) {
  const ids = new Set();
  for (const tenant of Array.isArray(tenants) ? tenants : []) {
    const id = normalizeInvoiceTenantUserId(tenant);
    if (id) ids.add(id);
  }
  return ids;
}

function invoiceHasOwnerAsTenant(invoice, ownerId) {
  const ownerStr = String(ownerId || '').trim();
  if (!ownerStr) return false;
  return collectInvoiceTenantUserIds(invoice?.tenants).has(ownerStr);
}

/**
 * Build Mongo filter for Autopay-owned invoices for one Owner + HOA.
 * Returns null when ids are invalid or the Owner has no property universe
 * (same empty outcome as Owner Invoices scope miss).
 *
 * Always includes tenants: ownerOid (chargeability gate). Never property-only.
 *
 * @param {{ userId: *, hoaId: *, extra?: object }} args
 * @returns {Promise<object|null>}
 */
async function buildOwnerAutopayInvoiceMongoFilter({ userId, hoaId, extra = {} } = {}) {
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);
  if (!userOid || !hoaOid) return null;

  const propertyIds = await resolveHoaOwnerInvoicePropertyIds(userOid);
  if (!propertyIds.length) return null;

  // Force ownership gates last so callers cannot override isolation via `extra`.
  return {
    isDeleted: { $ne: true },
    ...extra,
    hoaId: hoaOid,
    propertyId: propertyIds.length === 1 ? propertyIds[0] : { $in: propertyIds },
    tenants: userOid,
  };
}

/**
 * Event-driven / single-invoice chargeability: HOA match + tenant gate + property universe.
 */
async function isOwnerChargeableForAutopayInvoice({ userId, hoaId, invoice }) {
  const userOid = toObjectId(userId);
  const hoaOid = toObjectId(hoaId);
  if (!userOid || !hoaOid || !invoice) return false;

  const invoiceHoa = toObjectId(invoice.hoaId);
  if (!invoiceHoa || String(invoiceHoa) !== String(hoaOid)) return false;
  if (!invoiceHasOwnerAsTenant(invoice, userOid)) return false;

  const propertyIds = await resolveHoaOwnerInvoicePropertyIds(userOid);
  if (!propertyIds.length) return false;
  const propertyId = toObjectId(invoice.propertyId);
  if (!propertyId) return false;
  return propertyIds.map(String).includes(String(propertyId));
}

module.exports = {
  toObjectId,
  normalizeInvoiceTenantUserId,
  collectInvoiceTenantUserIds,
  invoiceHasOwnerAsTenant,
  buildOwnerAutopayInvoiceMongoFilter,
  isOwnerChargeableForAutopayInvoice,
};
