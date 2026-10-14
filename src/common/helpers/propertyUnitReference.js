/**
 * ------------------------------------------------------------------
 * File: propertyUnitReference.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for propertyUnitReference.
 *
 * Used By:
 * maintenanceEmailHelper, dashboard.service, expense.service, property.service
 * ------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Property = require('../../portals/landlord/modules/property/model/property.model');

function toObjectId(value) {
  const str = String(value && typeof value === 'object' && value._id ? value._id : value ?? '').trim();
  if (!mongoose.Types.ObjectId.isValid(str) || str.length !== 24) return null;
  return new mongoose.Types.ObjectId(str);
}

/**
 * Find a unit subdocument on a property by stable id and/or name.
 * @param {Array} unitDetails - property.unitDetails
 * @param {{ unitId?: string, unitName?: string }} input
 * @returns {object|null} unit subdoc or null
 */
function findUnitSubdocument(unitDetails, { unitId, unitName }) {
  const details = Array.isArray(unitDetails) ? unitDetails : [];
  if (unitId != null && String(unitId).trim() !== '' && mongoose.Types.ObjectId.isValid(String(unitId))) {
    const safeUnitId = toObjectId(unitId);
    if (!safeUnitId) return null;
    const sub = details.find((u) => u && u._id && String(u._id) === String(safeUnitId));
    return sub || null;
  }
  if (unitName != null && String(unitName).trim() !== '') {
    const lower = String(unitName).toLowerCase();
    return details.find((u) => u && u.unitName && String(u.unitName).toLowerCase() === lower) || null;
  }
  return null;
}

/**
 * Resolve unit id + canonical name for a property; throws with status when invalid.
 */
async function resolveUnitForPropertyId(propertyId, { unitId, unitName }, options = {}) {
  if (!propertyId || !mongoose.Types.ObjectId.isValid(String(propertyId))) {
    const err = new Error('Invalid propertyId');
    err.status = 400;
    throw err;
  }
  const safePropertyId = new mongoose.Types.ObjectId(String(propertyId));
  const q = Property.findById(safePropertyId).select('unitDetails');
  const property = options.session ? await q.session(options.session).lean() : await q.lean();
  if (!property) {
    const err = new Error('Property not found');
    err.status = 404;
    throw err;
  }
  const sub = findUnitSubdocument(property.unitDetails, { unitId, unitName });
  if (!sub) {
    const err = new Error(
      unitId && mongoose.Types.ObjectId.isValid(String(unitId))
        ? 'unitId does not match any unit on this property'
        : `unit '${unitName || ''}' not found on property`
    );
    err.status = 400;
    throw err;
  }
  return {
    unitId: sub._id,
    unitName: sub.unitName || '',
    subdocument: sub,
    property,
  };
}

/**
 * True if a lease row refers to the same physical unit as targetSub (by id or legacy name match).
 * @param {object} lease - lease lean doc
 * @param {Array} unitDetails - property.unitDetails
 * @param {object} targetSub - target unit subdocument { _id, unitName }
 */
function leaseReferencesSameUnit(lease, unitDetails, targetSub) {
  if (!lease || !targetSub) return false;
  const tid = String(targetSub._id);
  const details = Array.isArray(unitDetails) ? unitDetails : [];

  if (lease.unitId && String(lease.unitId) === tid) return true;

  if (lease.unitId) {
    const byLeaseId = details.find((u) => u && u._id && String(u._id) === String(lease.unitId));
    if (byLeaseId && String(byLeaseId._id) === tid) return true;
  }

  if ((!lease.unitId || lease.unitId === undefined) && lease.unitName) {
    const byName = details.find(
      (u) =>
        u &&
        u.unitName &&
        String(u.unitName).toLowerCase() === String(lease.unitName).toLowerCase()
    );
    if (byName && String(byName._id) === tid) return true;
  }

  return false;
}

/**
 * Current display name for a lease row using property.unitDetails (follows renames when lease has unitId).
 */
function resolvedUnitNameForLease(lease, propertyDoc) {
  if (!lease) return '';
  const details = propertyDoc && Array.isArray(propertyDoc.unitDetails) ? propertyDoc.unitDetails : [];
  if (lease.unitId) {
    const safeUnitId = toObjectId(lease.unitId);
    if (safeUnitId) {
      const sub = details.find((u) => u && u._id && String(u._id) === String(safeUnitId));
      if (sub && sub.unitName) return sub.unitName;
    }
  }
  return lease.unitName || '';
}

/**
 * Resolve unit subdocument for a maintenance row using unitId first, then legacy stored unit label.
 */
function unitSubdocumentForMaintenance(propertyDoc, maintenanceLean) {
  if (!maintenanceLean) return null;
  return findUnitSubdocument(propertyDoc?.unitDetails || [], {
    unitId: maintenanceLean.unitId,
    unitName: maintenanceLean.units,
  });
}

/**
 * Display unit name for API/dashboards - prefers Property.unitDetails via unitId.
 */
function unitDisplayNameFromMaintenance(propertyDoc, maintenanceLean) {
  const sub = unitSubdocumentForMaintenance(propertyDoc, maintenanceLean);
  if (sub && sub.unitName) return sub.unitName;
  if (maintenanceLean?.units != null && String(maintenanceLean.units).trim() !== '') {
    return String(maintenanceLean.units).trim();
  }
  return '';
}

module.exports = {
  findUnitSubdocument,
  resolveUnitForPropertyId,
  leaseReferencesSameUnit,
  resolvedUnitNameForLease,
  unitSubdocumentForMaintenance,
  unitDisplayNameFromMaintenance,
};
