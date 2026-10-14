const { escapeRegex } = require('../../../../../common/db/mongooseHelpers');

/**
 * Resolve a unit ref (unitDetails._id or unit name) to the canonical unit name
 * stored on system-generated invoices (unitDetails.unitName / unit title).
 */
function liveSoleUnitName(property) {
  const details = (property && Array.isArray(property.unitDetails)) ? property.unitDetails : [];
  if (details.length !== 1 || !details[0] || details[0].unitName == null) return '';
  return String(details[0].unitName).trim();
}

function resolveInvoiceUnitLabelFromProperty(property, unitRef) {
  const ref = String(unitRef || '').trim();
  const details = (property && Array.isArray(property.unitDetails)) ? property.unitDetails : [];

  if (ref) {
    const byId = details.find((d) => d && String(d._id) === ref);
    if (byId && byId.unitName) return String(byId.unitName).trim() || ref;

    const byName = details.find((d) => d && String(d.unitName || '').trim() === ref);
    if (byName && byName.unitName) return String(byName.unitName).trim();

    const refLower = ref.toLowerCase();
    const byNameCi = details.find(
      (d) => d && String(d.unitName || '').trim().toLowerCase() === refLower,
    );
    if (byNameCi && byNameCi.unitName) return String(byNameCi.unitName).trim();
  }

  // HOA stores one Property document per unit. After a unit-number rename the stored
  // invoice snapshot no longer matches unitDetails.unitName; use the live name.
  const soleName = liveSoleUnitName(property);
  if (soleName) return soleName;

  return ref || 'Unit';
}

function resolveInvoiceUnitNumber(invoice) {
  const property = invoice?.propertyId && typeof invoice.propertyId === 'object'
    ? invoice.propertyId
    : null;
  const resolved = resolveInvoiceUnitLabelFromProperty(property, invoice?.unit);
  if (resolved && resolved !== 'Unit') return resolved;
  const raw = String(invoice?.unit || '').trim();
  return raw || 'N/A';
}

/**
 * Collect all invoice.unit values that should match a list/filter unit param.
 * Manual invoices historically stored unitDetails._id; scheduled invoices store unitName.
 */
function collectUnitFilterAliases(unitRef, properties = []) {
  const unitStr = String(unitRef || '').trim();
  if (!unitStr) return [];

  const aliases = new Set([unitStr]);
  const unitStrLower = unitStr.toLowerCase();

  for (const prop of properties || []) {
    const details = Array.isArray(prop?.unitDetails) ? prop.unitDetails : [];
    for (const detail of details) {
      if (!detail) continue;
      const name = String(detail.unitName || '').trim();
      const id = detail._id != null ? String(detail._id) : '';
      const matches =
        (name && name.toLowerCase() === unitStrLower) ||
        (id && id === unitStr);
      if (!matches) continue;
      if (name) aliases.add(name);
      if (id) aliases.add(id);
    }
  }

  return [...aliases];
}

function buildUnitMongoFilter(aliases) {
  if (!aliases || aliases.length === 0) return null;
  if (aliases.length === 1) {
    const only = aliases[0];
    // Case-insensitive exact match when filtering by a single name-like value.
    // ObjectId strings stay exact via the same anchored regex.
    return { $regex: `^${escapeRegex(String(only))}$`, $options: 'i' };
  }
  return { $in: aliases };
}

module.exports = {
  resolveInvoiceUnitLabelFromProperty,
  resolveInvoiceUnitNumber,
  collectUnitFilterAliases,
  buildUnitMongoFilter,
};
