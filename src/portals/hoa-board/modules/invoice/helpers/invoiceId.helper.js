/**
 * ------------------------------------------------------------------
 * File: invoiceId.helper.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for invoiceId.helper.
 *
 * Used By:
 * invoice.service, invoicePolicyTerm.service, invoiceScheduleMeta.service, unitInvoice.service
 * ------------------------------------------------------------------
 */

const Invoice = require('../model/invoice.model');

const SHORT_INVOICE_ID_PATTERN = /^INV\d{6}$/;

/**
 * make Invoice Id
 *
 * Performs logic operations for makeInvoiceId.
 *
 * @returns Operations result
 */
function makeInvoiceId() {
  return `INV${Math.floor(100000 + Math.random() * 900000)}`;
}

/**
 * is Short Invoice Id
 *
 * Performs logic operations for isShortInvoiceId.
 *
 * @param invoiceId - Request/input argument
 * @returns Operations result
 */
function isShortInvoiceId(invoiceId) {
  return typeof invoiceId === 'string' && SHORT_INVOICE_ID_PATTERN.test(invoiceId.trim());
}

async function allocateUniqueInvoiceId(options = {}) {
  const [id] = await allocateUniqueInvoiceIds(1, options);
  return id;
}

/**
 * Allocate N unique short invoice IDs with batched collision checks (one query per batch).
 * @param {number} count
 * @param {{ session?: import('mongoose').ClientSession }} [options]
 * @returns {Promise<string[]>}
 */
async function allocateUniqueInvoiceIds(count, options = {}) {
  const needed = Math.floor(Number(count));
  if (!Number.isFinite(needed) || needed < 1) return [];

  const { session } = options;
  const assigned = new Set();
  const result = [];

  while (result.length < needed) {
    const batchSize = needed - result.length;
    const batch = [];
    for (let i = 0; i < batchSize; i += 1) {
      let candidate = makeInvoiceId();
      let guard = 0;
      while (assigned.has(candidate) && guard < 20) {
        candidate = makeInvoiceId();
        guard += 1;
      }
      batch.push(candidate);
    }

    let query = Invoice.find({ invoiceId: { $in: batch } }).select('invoiceId').lean();
    if (session) query = query.session(session);
    const existing = await query;
    const taken = new Set(existing.map((row) => row.invoiceId));

    for (const candidate of batch) {
      if (result.length >= needed) break;
      if (!taken.has(candidate) && !assigned.has(candidate)) {
        assigned.add(candidate);
        result.push(candidate);
      }
    }
  }

  return result;
}

async function resolveInvoiceIdForCreate(providedInvoiceId, options = {}) {
  if (providedInvoiceId && isShortInvoiceId(providedInvoiceId)) {
    const { session } = options;
    let query = Invoice.findOne({ invoiceId: providedInvoiceId.trim() });
    if (session) query = query.session(session);
    const exists = await query.lean();
    if (!exists) return providedInvoiceId.trim();
  }
  return allocateUniqueInvoiceId(options);
}

module.exports = {
  makeInvoiceId,
  isShortInvoiceId,
  allocateUniqueInvoiceId,
  allocateUniqueInvoiceIds,
  resolveInvoiceIdForCreate,
};
