'use strict';

const mongoose = require('mongoose');

/**
 * Decide how to apply units/unitId on a maintenance ticket update.
 * Empty values mean clear the unit (HOA edit can deselect property/unit).
 *
 * @returns {{ action: 'noop'|'clear'|'resolve', unitId?: string, unitName?: string, error?: string }}
 */
function planMaintenanceUnitUpdate(updates = {}, existingPropertyId = null) {
  const touchesUnit =
    Object.prototype.hasOwnProperty.call(updates, 'units')
    || Object.prototype.hasOwnProperty.call(updates, 'unitId');
  if (!touchesUnit) return { action: 'noop' };

  const clearingProperty =
    Object.prototype.hasOwnProperty.call(updates, 'property_id')
    && (updates.property_id == null || String(updates.property_id).trim() === '');

  const hasId =
    updates.unitId != null
    && String(updates.unitId).trim() !== ''
    && mongoose.Types.ObjectId.isValid(String(updates.unitId));
  const hasName = updates.units != null && String(updates.units).trim() !== '';

  if (!hasId && !hasName) {
    return { action: 'clear' };
  }
  if (clearingProperty) {
    return { action: 'clear' };
  }

  const propertyId = updates.property_id || existingPropertyId;
  if (!propertyId) {
    return { action: 'resolve', error: 'property_id is required when updating unit' };
  }

  return {
    action: 'resolve',
    unitId: hasId ? String(updates.unitId) : undefined,
    unitName: hasId ? undefined : String(updates.units),
  };
}

module.exports = {
  planMaintenanceUnitUpdate,
};
