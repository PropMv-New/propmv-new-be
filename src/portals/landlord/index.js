/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: Landlord Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for index.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const logger = require('../../common/logger');

// Middleware: normalize duplicated portal segment
// If a client accidentally requests /api/v1/landlord/landlord/..., rewrite the path
// to remove the duplicate 'landlord' segment so existing mounts work.
router.use((req, res, next) => {
	try {
		if (typeof req.path === 'string' && req.path.startsWith('/landlord/')) {
			const originalUrl = req.url;
			// remove the first '/landlord' segment
			req.url = req.url.replace('/landlord/', '/');
			req.path = req.path.replace('/landlord/', '/');
			// debug log so developers can see rewrites in server logs
			if (process.env.NODE_ENV !== 'production') {
				logger.debug(`[landlord-router] Rewrote duplicated segment: ${originalUrl} -> ${req.url}`);
			}
		}
	} catch (err) {
		// If anything goes wrong, continue with original request
	}
	return next();
});

// Import landlord-specific routes
const propertyRoutes = require('./modules/property/routes/property.routes');
const tenantRoutes = require('./modules/tenants/routes/tenants.routes');
const leaseRoutes = require('./modules/leasing/routes/lease.routes');
const maintenanceRoutes = require('../../shared/modules/maintenance/routes/maintenance.routes');
const expenseRoutes = require('../../shared/modules/expense/routes/expense.routes');
const invoiceRoutes = require('./modules/invoice/routes/invoice.routes');
const listingRoutes = require('./modules/listing/routes/listing.routes');
const dashboardRoutes = require('./modules/dashboard/routes/dashboard.routes');
const messagingRoutes = require('../../shared/messaging/routes/message.routes');
const emailRoutes = require('../../shared/modules/email/routes/email.routes');
const userProfileRoutes = require('../../shared/modules/users/routes/userProfile.routes');
const applicationRoutes = require('./modules/application/routes/application.routes');
const leasingLeaseRoutes = require('./modules/leasing/routes/lease.routes');
const leasingTemplateRoutes = require('./modules/leasing/routes/template.routes');
const insuranceRoutes = require('./modules/insurance/routes/quoteEstimate.routes');
const tenantScreeningSettingsRoutes = require('./modules/tenantScreeningSettings/routes/tenantScreeningSettings.routes');
const paymentManagementRoutes = require('./modules/payment-management/routes/paymentManagement.routes');
const billingSettingsRoutes = require('./modules/billing-settings/routes/billingSettings.routes');

// Mount landlord routes
router.use('/property', propertyRoutes);
router.use('/properties', propertyRoutes);
router.use('/tenant', tenantRoutes);
router.use('/tenants', tenantRoutes);
router.use('/lease', leaseRoutes);
router.use('/leases', leaseRoutes);
router.use('/maintenance', maintenanceRoutes);
router.use('/expense', expenseRoutes);
router.use('/expenses', expenseRoutes);
router.use('/invoice', invoiceRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/listing', listingRoutes);
router.use('/listings', listingRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/messaging', messagingRoutes);
router.use('/email', emailRoutes);
router.use('/users', userProfileRoutes);
router.use('/application', applicationRoutes);
router.use('/applications', applicationRoutes);
router.use('/leasing', leasingLeaseRoutes);
router.use('/leasing', leasingTemplateRoutes);
router.use('/insurance', insuranceRoutes);
router.use('/tenant-screening-settings', tenantScreeningSettingsRoutes);
router.use('/payment-management', paymentManagementRoutes);
router.use('/billing-settings', billingSettingsRoutes);

// Dynamically load all privilege-based route wrappers (these files mount
// their internal paths like '/payment-management' and apply auth/authorize)
// This allows clients that accidentally request /api/v1/landlord/landlord/... to
// be rewritten above and still reach the privilege-protected routes.
const privilegesPath = path.join(__dirname, 'privileges');
if (fs.existsSync(privilegesPath)) {
	fs.readdirSync(privilegesPath).forEach((privDir) => {
		const routeFile = path.join(privilegesPath, privDir, `${privDir}.routes.js`);
		// Some privilege folders may directly contain a single routes file named
		// like 'paymentManagement.routes.js' - try to require the folder's index
		// or any .routes.js file inside it.
		try {
			if (fs.existsSync(routeFile)) {
				const routes = require(routeFile);
				// mount the exported router at root of landlord portal
				router.use('/', routes);
			} else {
				// fallback: load any .routes.js file inside the privilege subfolder
				const files = fs.readdirSync(path.join(privilegesPath, privDir)).filter((f) => f.endsWith('.js'));
				files.forEach((f) => {
					const routes = require(path.join(privilegesPath, privDir, f));
					router.use('/', routes);
				});
			}
		} catch (err) {
			// non-fatal: continue loading other privilege routers
			if (process.env.NODE_ENV !== 'production') {
				logger.debug(`[landlord-privileges] failed to load ${privDir}:`, err.message);
			}
		}
	});
}

// Create a combined leasing router for both lease and template routes
const leasingRouter = express.Router();
leasingRouter.use(leasingLeaseRoutes);
leasingRouter.use(leasingTemplateRoutes);
router.use('/leasing', leasingRouter);

module.exports = router;
