'use strict';

/**
 * Modules/events that must use the reliable audit outbox in Phase 2.
 */
const CRITICAL_AUDIT_MODULES = new Set([
  'Payments',
  'PaymentCards',
  'StraddleAccount',
  'Rainforest',
  'Billing-settings',
  'BillingSettings',
  'Property',
  'Invoice',
  'Owner',
  'Users',
  'Company',
  'Auth',
  'Documents',
  'Hoa',
]);

function isCriticalAuditModule(moduleName, prepared = {}) {
  if (prepared.forceOutbox === true) return true;
  if (prepared.source === 'WEBHOOK') return true;
  const mod = String(moduleName || prepared.module || '').trim();
  if (!mod) return false;
  if (CRITICAL_AUDIT_MODULES.has(mod)) return true;
  // Normalized match (Billing-settings vs billingsettings)
  const normalized = mod.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const critical of CRITICAL_AUDIT_MODULES) {
    if (critical.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized) return true;
  }
  return false;
}

module.exports = {
  CRITICAL_AUDIT_MODULES,
  isCriticalAuditModule,
};
