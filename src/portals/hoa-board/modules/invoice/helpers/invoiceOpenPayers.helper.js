const { INVOICE_STATUS } = require('../../../../../common/constants/invoice');

const HISTORICAL_INVOICE_PAYER_STATUSES = new Set([
  INVOICE_STATUS.PAID,
  INVOICE_STATUS.PROCESSING,
  INVOICE_STATUS.WAIVED,
]);

function tenantId(tenant) {
  if (tenant && typeof tenant === 'object') {
    return String(tenant._id || tenant.id || '').trim();
  }
  return String(tenant || '').trim();
}

function currentOwnerIdSetFromProperty(property) {
  if (!property || typeof property !== 'object' || Array.isArray(property)) return null;
  const ids = property.associatedOwnerIds;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return new Set(
    ids
      .map((id) => String(id && typeof id === 'object' && id._id ? id._id : id).trim())
      .filter(Boolean)
  );
}

/**
 * Open unpaid invoices should list current unit owners, not removed co-owners.
 * Paid / processing / waived invoices keep the historical payer snapshot.
 */
function filterInvoiceTenantsToCurrentOwners(invoice) {
  const tenants = Array.isArray(invoice?.tenants) ? invoice.tenants : [];
  if (tenants.length === 0) return tenants;

  const storedStatus = String(invoice?.status || '');
  if (HISTORICAL_INVOICE_PAYER_STATUSES.has(storedStatus)) return tenants;
  if (Number(invoice?.processingAmount || 0) > 0) return tenants;

  const current = currentOwnerIdSetFromProperty(invoice?.propertyId);
  if (!current) return tenants;

  const filtered = tenants.filter((tenant) => current.has(tenantId(tenant)));
  return filtered.length > 0 ? filtered : tenants;
}

module.exports = {
  filterInvoiceTenantsToCurrentOwners,
  currentOwnerIdSetFromProperty,
};
