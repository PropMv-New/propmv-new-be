'use strict';

const mongoose = require('mongoose');
const User = require('../../../../../shared/modules/users/models/user.model');

function tenantId(tenant) {
  if (tenant && typeof tenant === 'object') {
    return String(tenant._id || tenant.id || '').trim();
  }
  return String(tenant || '').trim();
}

function isNamedPayer(tenant) {
  if (!tenant || typeof tenant !== 'object') return false;
  const first = String(tenant.firstName || '').trim();
  const last = String(tenant.lastName || '').trim();
  const name = String(tenant.name || '').trim();
  const email = String(tenant.email || '').trim();
  return Boolean(first || last || name || (email && email !== 'N/A'));
}

function currentOwnerIdsFromProperty(property) {
  if (!property || typeof property !== 'object' || Array.isArray(property)) return [];
  const records = Array.isArray(property.ownershipRecords) ? property.ownershipRecords : [];
  if (records.length > 0) {
    const now = Date.now();
    const active = records
      .filter((record) => {
        const start = record?.startDate ? new Date(record.startDate).getTime() : 0;
        const end = record?.endDate ? new Date(record.endDate).getTime() : Number.POSITIVE_INFINITY;
        return Number.isFinite(start) && start <= now && now < end;
      })
      .map((record) => String(record.ownerId?._id || record.ownerId || '').trim())
      .filter(Boolean);
    if (active.length > 0) return [...new Set(active)];
  }
  return [
    ...new Set(
      (property.associatedOwnerIds || [])
        .map((id) => String(id && typeof id === 'object' && id._id ? id._id : id).trim())
        .filter(Boolean)
    ),
  ];
}

function collectInvoicePayerIds(invoice) {
  const ids = new Set();
  for (const tenant of invoice?.tenants || []) {
    const id = tenantId(tenant);
    if (id) ids.add(id);
  }
  currentOwnerIdsFromProperty(invoice?.propertyId).forEach((id) => ids.add(id));
  return [...ids];
}

function applyHydratedPayers(invoice, usersById) {
  if (!invoice || !usersById) return invoice;

  const seen = new Set();
  const resolved = [];

  const pushUser = (id) => {
    if (!id || seen.has(id)) return;
    const user = usersById.get(id);
    if (!user) return;
    seen.add(id);
    resolved.push(user);
  };

  for (const tenant of invoice.tenants || []) {
    if (isNamedPayer(tenant)) {
      const id = tenantId(tenant);
      if (id) seen.add(id);
      resolved.push(tenant);
      continue;
    }
    pushUser(tenantId(tenant));
  }

  if (resolved.length === 0) {
    currentOwnerIdsFromProperty(invoice.propertyId).forEach(pushUser);
  }

  invoice.tenants = resolved;
  return invoice;
}

async function hydrateInvoicePayers(invoices) {
  const list = Array.isArray(invoices) ? invoices.filter(Boolean) : [];
  if (list.length === 0) return list;

  const idSet = new Set();
  list.forEach((invoice) => {
    collectInvoicePayerIds(invoice).forEach((id) => idSet.add(id));
  });

  const objectIds = [...idSet]
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  if (objectIds.length === 0) {
    list.forEach((invoice) => applyHydratedPayers(invoice, new Map()));
    return list;
  }

  const users = await User.find({ _id: { $in: objectIds } })
    .select('firstName lastName email phone address mailingAddress')
    .lean();
  const usersById = new Map(users.map((user) => [String(user._id), user]));
  list.forEach((invoice) => applyHydratedPayers(invoice, usersById));
  return list;
}

module.exports = {
  tenantId,
  isNamedPayer,
  currentOwnerIdsFromProperty,
  collectInvoicePayerIds,
  applyHydratedPayers,
  hydrateInvoicePayers,
};
