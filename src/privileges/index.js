/**
 * Aggregated API privilege maps + intentional auth-only allow-list.
 * Used by authorize middleware (fail-closed) and privilege coverage tests.
 */

const authRoutePrivileges = require('./auth/auth.routes');
const usersRoutePrivileges = require('./users/users.routes');
const rolesRoutePrivileges = require('./auth/roles.routes');
const functionsRoutePrivileges = require('./auth/functions.routes');
const propertyRoutePrivileges = require('./property/property.routes');
const masterRoutePrivileges = require('./master/masterData.routes');
const tenantsRoutePrivileges = require('./tenants/tenants.routes');
const leasingRoutePrivileges = require('./leasing/leases.routes');
const maintenanceRoutePrivileges = require('./maintenance/maintenance.routes');
const damageReportRoutePrivileges = require('./maintenance/damageReport.routes');
const applicationRoutePrivileges = require('./application/application.routes');
const dashboardRoutePrivileges = require('./dashboard/dashboard.routes');
const incomeRoutePrivileges = require('./income/income.routes');
const expenseRoutePrivileges = require('./expense/expense.routes');
const ownersRoutePrivileges = require('./owners/owners.routes');
const boardMembersRoutePrivileges = require('./hoa/boardMembers.routes');
const hoaSettingsRoutePrivileges = require('./hoa/hoaSettings.routes');
const billingSettingsRoutePrivileges = require('./hoa/billingSettings.routes');
const eventsRoutePrivileges = require('./events/events.routes');
const listingRoutePrivileges = require('./listing/listing.routes');
const tenantScreeningSettingsRoutePrivileges = require('./tenantScreeningSettings/tenantScreeningSettings.routes');
const documentsRoutePrivileges = require('./documents/documents.routes');
const paymentsRoutePrivileges = require('./payments/payments.routes');
const rainforestRoutePrivileges = require('./payments/rainforest.routes');
const payloadRoutePrivileges = require('./payments/payload.routes');
const accountsRoutePrivileges = require('./accounts/accounts.routes');
const paymentManagementRoutePrivileges = require('./payment-management/payment-management.routes');
const emailRoutePrivileges = require('./email/email.routes');
const insuranceRoutePrivileges = require('./insurance/insurance.routes');
const companyRoutePrivileges = require('./company/company.routes');
const vendorInvoiceRoutePrivileges = require('./vendor-invoice/vendor-invoice.routes');
const vendorsRoutePrivileges = require('./vendors/vendors.routes');
const notificationsRoutePrivileges = require('./notifications/notifications.routes');

/** All privilege maps consulted by authorize (order does not matter for exact key match). */
const PRIVILEGE_MAPS = [
  authRoutePrivileges,
  usersRoutePrivileges,
  rolesRoutePrivileges,
  functionsRoutePrivileges,
  propertyRoutePrivileges,
  masterRoutePrivileges,
  tenantsRoutePrivileges,
  leasingRoutePrivileges,
  maintenanceRoutePrivileges,
  damageReportRoutePrivileges,
  applicationRoutePrivileges,
  dashboardRoutePrivileges,
  incomeRoutePrivileges,
  expenseRoutePrivileges,
  ownersRoutePrivileges,
  boardMembersRoutePrivileges,
  hoaSettingsRoutePrivileges,
  billingSettingsRoutePrivileges,
  eventsRoutePrivileges,
  listingRoutePrivileges,
  tenantScreeningSettingsRoutePrivileges,
  documentsRoutePrivileges,
  paymentsRoutePrivileges,
  rainforestRoutePrivileges,
  payloadRoutePrivileges,
  accountsRoutePrivileges,
  paymentManagementRoutePrivileges,
  emailRoutePrivileges,
  insuranceRoutePrivileges,
  companyRoutePrivileges,
  vendorInvoiceRoutePrivileges,
  vendorsRoutePrivileges,
  notificationsRoutePrivileges,
];

/**
 * Routes that use `authorize` but intentionally require only authentication
 * (no specific privilege). Prefer empty-array entries in a privilege map when possible.
 * Keys: "METHOD /api/v1/..." after portal prefix stripping.
 */
const UNPRIVILEGED_ROUTE_ALLOWLIST = new Set([
  // Keep empty - intentional auth-only routes should use `[]` in a privilege map.
  // Example: 'GET /api/v1/users/weather' is mapped as [] in users.routes.js
]);

module.exports = {
  PRIVILEGE_MAPS,
  UNPRIVILEGED_ROUTE_ALLOWLIST,
};
