/**
 * ------------------------------------------------------------------
 * File: lateFeeLineItems.helper.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for lateFeeLineItems.helper.
 *
 * Used By:
 * invoice.service, unitLateFee.service
 * ------------------------------------------------------------------
 */

const roundCurrency = (value) => Number((Number(value) || 0).toFixed(2));

const LATE_FEE_LINE_ITEM_RE = /late fee/i;

/**
 * is Late Fee Line Item
 *
 * Performs logic operations for isLateFeeLineItem.
 *
 * @param item - Request/input argument
 * @returns Operations result
 */
function isLateFeeLineItem(item) {
  if (!item || typeof item !== 'object') return false;
  const text = `${item.invoiceItem || ''} ${item.description || ''}`.trim();
  return LATE_FEE_LINE_ITEM_RE.test(text);
}

/**
 * line Item Label Key
 *
 * Performs logic operations for lineItemLabelKey.
 *
 * @param item - Request/input argument
 * @returns Operations result
 */
function lineItemLabelKey(item) {
  return String(item?.invoiceItem || 'Late Fee').trim().toLowerCase();
}

/**
 * line Item Per Unit Rate
 *
 * Performs logic operations for lineItemPerUnitRate.
 *
 * @param item - Request/input argument
 * @returns Operations result
 */
function lineItemPerUnitRate(item) {
  const qty = Math.max(1, Number(item?.quantity) || 1);
  if (item?.rate != null && Number(item.rate) > 0) {
    return roundCurrency(item.rate);
  }
  return roundCurrency((Number(item?.amount) || 0) / qty);
}

/**
 * build Consolidated Late Fee Description
 *
 * Performs logic operations for buildConsolidatedLateFeeDescription.
 *
 * @param label - Request/input argument
 * @param quantity - Request/input argument
 * @param perUnitRate - Request/input argument
 * @param fallbackDescription - Request/input argument
 * @returns Operations result
 */
function buildConsolidatedLateFeeDescription(label, quantity, perUnitRate, fallbackDescription = '') {
  const itemLabel = String(label || 'Late Fee').trim();
  const rateText = `$${perUnitRate.toFixed(2)}`;
  if (quantity <= 1) {
    return fallbackDescription || `${itemLabel}. Charge amount: ${rateText}.`;
  }
  return `${itemLabel} × ${quantity}. Charge amount: ${rateText} each.`;
}

/**
 * Merge late fee rows that share the same label and per-unit rate into one row with quantity.
 */
function consolidateLateFeeLineItems(items) {
  const source = Array.isArray(items) ? items : [];
  const nonLate = [];
  const groups = new Map();

  for (const item of source) {
    if (!isLateFeeLineItem(item)) {
      nonLate.push(item);
      continue;
    }

    const label = String(item.invoiceItem || 'Late Fee').trim();
    const rate = lineItemPerUnitRate(item);
    const key = `${lineItemLabelKey(item)}|${rate}`;
    const addQty = Math.max(1, Number(item.quantity) || 1);

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        invoiceItem: label,
        description: item.description || buildConsolidatedLateFeeDescription(label, addQty, rate),
        quantity: addQty,
        rate,
        amount: roundCurrency(addQty * rate),
      });
      continue;
    }

    existing.quantity += addQty;
    existing.amount = roundCurrency(existing.quantity * existing.rate);
    existing.description = buildConsolidatedLateFeeDescription(
      existing.invoiceItem,
      existing.quantity,
      existing.rate,
      item.description || existing.description
    );
  }

  return [...nonLate, ...groups.values()];
}

/**
 * Add or increment a late fee line item on an invoice (same label + rate → quantity++).
 */
function upsertLateFeeLineItem(invoiceItemDetails, { lineItemLabel, description, amount }) {
  const details = Array.isArray(invoiceItemDetails) ? invoiceItemDetails : [];
  const label = String(lineItemLabel || 'Late Fee').trim();
  const rate = roundCurrency(amount);
  const key = `${label.toLowerCase()}|${rate}`;

  const idx = details.findIndex((item) => {
    if (!isLateFeeLineItem(item)) return false;
    return `${lineItemLabelKey(item)}|${lineItemPerUnitRate(item)}` === key;
  });

  if (idx < 0) {
    details.push({
      invoiceItem: label,
      description,
      quantity: 1,
      rate,
      amount: rate,
    });
    return details;
  }

  const existing = details[idx];
  const quantity = Math.max(1, Number(existing.quantity) || 1) + 1;
  details[idx] = {
    ...existing,
    invoiceItem: label,
    quantity,
    rate,
    amount: roundCurrency(quantity * rate),
    description: buildConsolidatedLateFeeDescription(label, quantity, rate, description),
  };
  return details;
}

module.exports = {
  isLateFeeLineItem,
  consolidateLateFeeLineItems,
  upsertLateFeeLineItem,
  buildConsolidatedLateFeeDescription,
  lineItemPerUnitRate,
  roundCurrency,
};
