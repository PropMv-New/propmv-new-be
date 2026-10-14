/**
 * ------------------------------------------------------------------
 * File: landlordInvoicePayment.helper.js
 * Module: Backend Utilities
 *
 * Purpose:
 * Backend utility/module providing helper functions for landlordInvoicePayment.helper.
 *
 * Used By:
 * depositRefundInvoice.helpers, invoice.service
 * ------------------------------------------------------------------
 */

/**
 * round Currency
 *
 * Performs logic operations for roundCurrency.
 *
 * @param value - Request/input argument
 * @returns Operations result
 */
function roundCurrency(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

/**
 * sum Tenant Payments
 *
 * Performs logic operations for sumTenantPayments.
 *
 * @param invoice - Request/input argument
 * @param tenantId - Request/input argument
 * @returns Operations result
 */
function sumTenantPayments(invoice, tenantId) {
  if (!tenantId) return 0;
  const history = Array.isArray(invoice?.paymentHistory) ? invoice.paymentHistory : [];
  return roundCurrency(
    history
      .filter((entry) => String(entry?.userId) === String(tenantId))
      .reduce((sum, entry) => sum + Number(entry.paymentAmount || 0), 0)
  );
}

/**
 * resolve Tenant Portion From Lease
 *
 * Performs logic operations for resolveTenantPortionFromLease.
 *
 * @param invoice - Request/input argument
 * @param lease - Request/input argument
 * @param tenantId - Request/input argument
 * @returns Operations result
 */
function resolveTenantPortionFromLease(invoice, lease, tenantId) {
  const split = lease?.rentAndDepositDestribution?.split || [];
  const entry = split.find((row) => String(row?.tenantId) === String(tenantId));
  if (!entry) return null;

  const pct = Number(entry.rentPercentage || 0);
  const subAmount = Number(invoice?.subAmount || 0);
  if (pct > 0) return roundCurrency((subAmount * pct) / 100);
  if (split.length > 0) return roundCurrency(subAmount / split.length);
  return null;
}

/**
 * resolve Tenant Portion From Line Items
 *
 * Performs logic operations for resolveTenantPortionFromLineItems.
 *
 * @param invoice - Request/input argument
 * @param tenantName - Request/input argument
 * @returns Operations result
 */
function resolveTenantPortionFromLineItems(invoice, tenantName) {
  if (!tenantName) return 0;
  const needle = tenantName.trim().toLowerCase();
  if (!needle) return 0;

  const items = Array.isArray(invoice?.invoiceItemDetails) ? invoice.invoiceItemDetails : [];
  return roundCurrency(
    items.reduce((sum, item) => {
      const label = `${item?.invoiceItem || ''} ${item?.description || ''}`.toLowerCase();
      if (label.includes(needle)) {
        return sum + Number(item?.amount || 0);
      }
      return sum;
    }, 0)
  );
}

/**
 * Resolve how much a tenant may still pay on an invoice when tenants are individually responsible.
 */
function resolveTenantPaymentLimits(invoice, lease, tenantId, tenantNameById = {}) {
  const balanceDue = roundCurrency(invoice?.balanceDue || 0);
  const equallyResponsible = lease?.rentAndDepositDestribution?.isAllTenantsEquallyResponsible !== false;

  if (equallyResponsible || !tenantId) {
    return {
      equallyResponsible: true,
      tenantRemainingPortion: balanceDue,
      maxPaymentBeforeOverpayment: balanceDue,
    };
  }

  const tenantName = tenantNameById[String(tenantId)] || '';
  let assignedPortion = resolveTenantPortionFromLineItems(invoice, tenantName);
  if (assignedPortion <= 0) {
    assignedPortion = resolveTenantPortionFromLease(invoice, lease, tenantId) || 0;
  }

  const paidByTenant = sumTenantPayments(invoice, tenantId);
  const tenantRemainingPortion = roundCurrency(Math.max(0, assignedPortion - paidByTenant));
  const maxPaymentBeforeOverpayment = roundCurrency(Math.min(tenantRemainingPortion, balanceDue));

  return {
    equallyResponsible: false,
    tenantRemainingPortion,
    maxPaymentBeforeOverpayment,
    assignedPortion,
    paidByTenant,
  };
}

/**
 * Validate a landlord-recorded payment against lease partial-payment and tenant-responsibility rules.
 */
function validateLandlordInvoicePayment(invoice, lease, paymentAmount, paymentUserId, tenantNameById = {}) {
  const amount = roundCurrency(paymentAmount);
  const balanceDue = roundCurrency(invoice?.balanceDue || 0);
  if (amount <= 0) {
    return { ok: false, message: 'Payment amount must be greater than zero.' };
  }

  const limits = resolveTenantPaymentLimits(invoice, lease, paymentUserId, tenantNameById);
  const partialAllowed = Boolean(invoice?.isPartialPaymentAllowed);
  const isInvoiceOverpayment = amount > balanceDue + 0.004;
  const partialThreshold = limits.equallyResponsible
    ? balanceDue
    : limits.maxPaymentBeforeOverpayment;

  if (!partialAllowed && amount + 0.004 < partialThreshold) {
    if (limits.equallyResponsible) {
      return {
        ok: false,
        status: 400,
        message: 'Partial payments are not allowed for this invoice. Please pay the full balance due.',
      };
    }
    return {
      ok: false,
      status: 400,
      message: `Partial payments are not allowed for this invoice. This tenant must pay their full portion of $${partialThreshold.toFixed(2)}.`,
    };
  }

  if (
    !limits.equallyResponsible
    && paymentUserId
    && amount + 0.004 < balanceDue
    && amount > limits.maxPaymentBeforeOverpayment + 0.004
  ) {
    return {
      ok: false,
      status: 400,
      message: `This tenant is only responsible for their portion ($${limits.maxPaymentBeforeOverpayment.toFixed(2)} remaining). Pay the full invoice balance to settle all tenants at once.`,
    };
  }

  return { ok: true, limits, isInvoiceOverpayment };
}

module.exports = {
  roundCurrency,
  sumTenantPayments,
  resolveTenantPortionFromLease,
  resolveTenantPortionFromLineItems,
  resolveTenantPaymentLimits,
  validateLandlordInvoicePayment,
};
