'use strict';

/** Matches hoaSettings.model.js paymentTerm.dueDay default. */
const DEFAULT_HOA_PAYMENT_DUE_DAY = 1;

function normalizePaymentDueDay(raw, fallback = DEFAULT_HOA_PAYMENT_DUE_DAY) {
  if (raw != null && Number.isFinite(Number(raw))) {
    return Math.min(31, Math.max(1, Math.floor(Number(raw))));
  }
  return fallback;
}

/**
 * Resolve invoice due day.
 * Default: explicit value > unit requestPayload snapshot > HOA settings > default (1).
 * When preferHoaSettings is true (fresh billing after ownerless), HOA settings beat stale snapshots.
 */
function resolvePaymentDueDayFromSources({
  explicitDay,
  requestPayload,
  hoaSettings,
  preferHoaSettings = false,
} = {}) {
  if (explicitDay != null && Number.isFinite(Number(explicitDay))) {
    return normalizePaymentDueDay(explicitDay);
  }

  const rp = requestPayload && typeof requestPayload === 'object' && !Array.isArray(requestPayload)
    ? requestPayload
    : null;

  const settingsDay = hoaSettings?.paymentTerm?.dueDay;
  if (preferHoaSettings && settingsDay != null && Number.isFinite(Number(settingsDay))) {
    return normalizePaymentDueDay(settingsDay);
  }

  if (rp?.paymentDueDay != null && Number.isFinite(Number(rp.paymentDueDay))) {
    return normalizePaymentDueDay(rp.paymentDueDay);
  }

  if (settingsDay != null && Number.isFinite(Number(settingsDay))) {
    return normalizePaymentDueDay(settingsDay);
  }

  return DEFAULT_HOA_PAYMENT_DUE_DAY;
}

module.exports = {
  DEFAULT_HOA_PAYMENT_DUE_DAY,
  normalizePaymentDueDay,
  resolvePaymentDueDayFromSources,
};
