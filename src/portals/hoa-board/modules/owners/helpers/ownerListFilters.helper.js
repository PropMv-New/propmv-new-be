const mongoose = require('mongoose');
const { USER_STATUSES } = require('../../../../../common/constants/user');
const { PORTAL_ONBOARDING_STATUS } = require('../../../../../common/constants/portalOnboarding');

function mapOwnerAccountStatusFilters(statuses = []) {
  const portalStatuses = new Set();
  const userStatuses = new Set();

  for (const raw of statuses) {
    const label = String(raw || '').trim();
    if (!label) continue;
    if (label === 'Verified') {
      portalStatuses.add(PORTAL_ONBOARDING_STATUS.ACTIVE);
    } else if (label === 'Active') {
      portalStatuses.add(PORTAL_ONBOARDING_STATUS.ACTIVE);
      userStatuses.add(USER_STATUSES.ACTIVE);
    } else if (label === 'Pending Verification') {
      portalStatuses.add(PORTAL_ONBOARDING_STATUS.PENDING_VERIFICATION);
    } else if (label === 'Invitation Sent') {
      portalStatuses.add(PORTAL_ONBOARDING_STATUS.INVITATION_SENT);
      portalStatuses.add('invited');
    } else {
      portalStatuses.add(label.toLowerCase().replace(/\s+/g, '_'));
      userStatuses.add(label);
    }
  }

  return {
    portalStatuses: Array.from(portalStatuses),
    userStatuses: Array.from(userStatuses),
  };
}

async function resolveOwnerPropertyScopeIds({
  propertyId = '',
  unitId = '',
  unitName = '',
} = {}) {
  const Property = require('../../property/model/property.model');
  const unitScopeIds = new Set();
  const trimmedUnitName = unitName ? String(unitName).trim() : '';
  const propertyIdFilter = propertyId && mongoose.Types.ObjectId.isValid(String(propertyId))
    ? String(propertyId)
    : '';
  const unitIdFilter = unitId && mongoose.Types.ObjectId.isValid(String(unitId))
    ? String(unitId)
    : '';

  const hasUnitScope = Boolean(
    unitIdFilter || (propertyIdFilter && trimmedUnitName) || propertyIdFilter,
  );
  if (!hasUnitScope) return null;

  if (unitIdFilter) {
    unitScopeIds.add(unitIdFilter);
  }

  if (propertyIdFilter) {
    const parent = await Property.findById(propertyIdFilter).select('landlord_id unitDetails name').lean();
    if (parent) {
      const detail = parent.unitDetails?.find((row) => {
        if (unitIdFilter && row && String(row._id) === unitIdFilter) return true;
        return trimmedUnitName && row && String(row.unitName || '').trim() === trimmedUnitName;
      });
      const resolvedUnitName = trimmedUnitName || (detail?.unitName ? String(detail.unitName).trim() : '');

      if (resolvedUnitName) {
        const scopedUnits = await Property.find({
          landlord_id: parent.landlord_id,
          isDeleted: { $ne: true },
          isArchieved: { $ne: true },
          $or: [
            { _id: propertyIdFilter, 'unitDetails.unitName': resolvedUnitName },
            { name: resolvedUnitName },
            { 'unitDetails.unitName': resolvedUnitName },
          ],
        }).select('_id').lean();
        scopedUnits.forEach((row) => unitScopeIds.add(String(row._id)));
      } else if (!unitIdFilter) {
        unitScopeIds.add(propertyIdFilter);
      }
    } else if (!unitIdFilter) {
      unitScopeIds.add(propertyIdFilter);
    }
  }

  return unitScopeIds.size > 0 ? Array.from(unitScopeIds) : null;
}

function toValidObjectIdString(value) {
  const str = String(value || '').trim();
  return str && mongoose.Types.ObjectId.isValid(str) ? str : '';
}

/**
 * Property document ids for invoice/owner pickers.
 * HOA search items send propertyId = Property._id and unitId = unitDetails._id
 * (embedded). Only Property collection ids can be used to load associated owners.
 */
async function resolveOwnerPickerPropertyIds({
  propertyId = '',
  unitId = '',
  unitName = '',
} = {}) {
  const Property = require('../../property/model/property.model');
  const ids = new Set();
  const propertyIdFilter = toValidObjectIdString(propertyId);
  const unitIdFilter = toValidObjectIdString(unitId);

  const addIfPropertyDoc = async (id) => {
    if (!id || ids.has(id)) return;
    const doc = await Property.findById(id).select('_id').lean();
    if (doc?._id) ids.add(String(doc._id));
  };

  await addIfPropertyDoc(propertyIdFilter);
  if (unitIdFilter && unitIdFilter !== propertyIdFilter) {
    await addIfPropertyDoc(unitIdFilter);
  }

  if (ids.size === 0 && unitIdFilter) {
    const oid = new mongoose.Types.ObjectId(unitIdFilter);
    const byDetail = await Property.findOne({
      isDeleted: { $ne: true },
      $or: [{ _id: oid }, { 'unitDetails._id': oid }],
    }).select('_id').lean();
    if (byDetail?._id) ids.add(String(byDetail._id));
  }

  if (ids.size === 0) {
    const scoped = await resolveOwnerPropertyScopeIds({ propertyId, unitId, unitName });
    for (const candidate of scoped || []) {
      await addIfPropertyDoc(candidate);
    }
  }

  return ids.size > 0 ? Array.from(ids) : null;
}

function mapInvoiceToOwnerPaymentStatus(invoice, getEffectiveInvoiceStatus) {
  const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');
  const effectiveStatus = getEffectiveInvoiceStatus(invoice);
  if (effectiveStatus === INVOICE_STATUS.PAID || effectiveStatus === INVOICE_STATUS.WAIVED) {
    return 'Paid';
  }
  if (effectiveStatus === INVOICE_STATUS.OVERDUE) {
    return 'Overdue';
  }
  return 'Due';
}

async function findOwnerIdsByPaymentStatuses(paymentStatuses = [], hoaContext = null) {
  const normalized = paymentStatuses
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!normalized.length) return null;

  const Invoice = require('../../invoice/model/invoice.model');
  const { buildHoaBoardPropertyMatch } = require('../../../../../middleware/hoaDataIsolation');
  const { getEffectiveInvoiceStatus } = require('../../invoice/service/invoice.service');
  const invoiceFilter = {
    isDeleted: { $ne: true },
    tenants: { $exists: true, $not: { $size: 0 } },
  };
  if (hoaContext?.isHOABoardMember) {
    const hoaPropScope = buildHoaBoardPropertyMatch(hoaContext);
    if (hoaPropScope) {
      invoiceFilter.$and = [hoaPropScope];
    }
  }

  const invoices = await Invoice.find(invoiceFilter)
    .select('tenants status dueDate alreadyPaid balanceDue waivedAmount processingAmount paymentTransactions')
    .lean();

  const ownerIds = new Set();
  const wanted = new Set(normalized.map((value) => value.toLowerCase()));

  for (const invoice of invoices) {
    const category = mapInvoiceToOwnerPaymentStatus(invoice, getEffectiveInvoiceStatus);
    if (!wanted.has(category.toLowerCase())) continue;
    (invoice.tenants || []).forEach((tenantId) => ownerIds.add(String(tenantId)));
  }

  return Array.from(ownerIds);
}

function buildOwnerStatusFilter(ownerStatus = '') {
  const statuses = String(ownerStatus).split(',').map((s) => s.trim()).filter(Boolean);
  if (!statuses.length) return null;

  const statusOr = [];
  if (statuses.includes('Active')) {
    statusOr.push({
      status: USER_STATUSES.ACTIVE,
      isArchived: { $ne: true },
    });
  }
  if (statuses.includes('Inactive')) {
    statusOr.push({
      $or: [
        { status: { $in: [USER_STATUSES.INACTIVE, USER_STATUSES.LOCKED] } },
        { isArchived: true },
      ],
    });
  }
  if (!statusOr.length) return null;
  return statusOr.length === 1 ? statusOr[0] : { $or: statusOr };
}

function buildOwnerAccountStatusFilter(accountStatus = '') {
  const statuses = String(accountStatus).split(',').map((s) => s.trim()).filter(Boolean);
  if (!statuses.length) return null;

  const mapped = mapOwnerAccountStatusFilters(statuses);
  const statusOr = [];
  if (mapped.portalStatuses.length) {
    statusOr.push({ portalOnboardingStatus: { $in: mapped.portalStatuses } });
  }
  if (mapped.userStatuses.length) {
    statusOr.push({ status: { $in: mapped.userStatuses } });
  }
  if (!statusOr.length) return null;
  return statusOr.length === 1 ? statusOr[0] : { $or: statusOr };
}

function ownerIdToString(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

/**
 * Current owners for invoice/unit pickers: timeline current owners plus associatedOwnerIds.
 * Union is required because co-owners can be linked on the unit while User.propertyIds
 * (or a sparse ownershipRecords timeline) still omits them.
 */
function collectAssignedOwnerIdsFromUnits(units = [], getCurrentOwnerIds) {
  const ids = new Set();
  const add = (value) => {
    const str = ownerIdToString(value).trim();
    if (str && str !== 'undefined' && str !== 'null') ids.add(str);
  };

  for (const unit of units || []) {
    const current = typeof getCurrentOwnerIds === 'function' ? getCurrentOwnerIds(unit) : [];
    (Array.isArray(current) ? current : []).forEach(add);
    (unit?.associatedOwnerIds || []).forEach(add);
  }

  return Array.from(ids);
}

module.exports = {
  mapOwnerAccountStatusFilters,
  resolveOwnerPropertyScopeIds,
  resolveOwnerPickerPropertyIds,
  mapInvoiceToOwnerPaymentStatus,
  findOwnerIdsByPaymentStatuses,
  buildOwnerStatusFilter,
  buildOwnerAccountStatusFilter,
  collectAssignedOwnerIdsFromUnits,
};
