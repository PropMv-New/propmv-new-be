/**
 * ------------------------------------------------------------------
 * File: landlordRouteConfig.js
 * Module: Src Config
 *
 * Purpose:
 * Backend utility/module providing helper functions for landlordRouteConfig.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

const { landlordDataIsolation } = require('../middleware/landlordDataIsolation');
const { resolveCreatedBy } = require('../shared/utils/creatorScope.util');

/**
 * Landlord Route Configuration Helper
 * Provides centralized configuration for applying landlord data isolation
 */
const applyLandlordDataIsolationToRoutes = (app) => {
  const protectedRoutes = [
    '/api/v1/landlord/property*',
    '/api/v1/landlord/properties*',
    '/api/v1/landlord/tenant*',
    '/api/v1/landlord/tenants*',
    '/api/v1/landlord/expense*',
    '/api/v1/landlord/expenses*',
    '/api/v1/landlord/invoice*',
    '/api/v1/landlord/invoices*',
    '/api/v1/landlord/lease*',
    '/api/v1/landlord/leases*',
    '/api/v1/landlord/maintenance*',
    '/api/v1/landlord/dashboard*',
    '/api/v1/landlord/listing*'
  ];

  protectedRoutes.forEach(route => {
    app.use(route, landlordDataIsolation);
  });
};

const withLandlordContext = (serviceMethod) => {
  return async (req, res, next) => {
    try {
      const userContext = req.landlordContext || null;
      const result = await serviceMethod(req, res, userContext);
      return result;
    } catch (error) {
      next(error);
    }
  };
};

const filterResponseForLandlord = (data, userContext) => {
  if (!userContext || !userContext.isLandlord) {
    return data;
  }

  if (Array.isArray(data)) {
    return data.filter((item) => resolveCreatedBy(item) === String(userContext.userId));
  }

  if (data && typeof data === 'object') {
    const hasAccess = resolveCreatedBy(data) === String(userContext.userId);
    return hasAccess ? data : null;
  }

  return data;
};

module.exports = {
  applyLandlordDataIsolationToRoutes,
  withLandlordContext,
  filterResponseForLandlord
};
