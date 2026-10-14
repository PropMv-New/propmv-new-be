/**
 * ------------------------------------------------------------------
 * File: hoaRouteConfig.js
 * Module: Src Config
 *
 * Purpose:
 * Backend utility/module providing helper functions for hoaRouteConfig.
 *
 * Used By:
 * property.controller
 * ------------------------------------------------------------------
 */

const { hoaDataIsolation } = require('../middleware/hoaDataIsolation');

/**
 * HOA Route Configuration Helper
 * 
 * This module provides centralized configuration for applying HOA data isolation
 * across all relevant API routes. It includes:
 * 
 * 1. Route Protection: Automatically applies HOA middleware to protected routes
 * 2. Service Wrappers: Provides helpers to pass user context to service methods
 * 3. Response Filtering: Ensures responses are filtered based on HOA ownership
 * 
 * Protected Routes:
 * - All property-related endpoints (/api/v1/property*, /api/v1/properties*)
 * - Owner and tenant management (/api/v1/owner*, /api/v1/tenant*)
 * - Financial records (/api/v1/expense*, /api/v1/invoice*, /api/v1/income*)
 * - Maintenance requests (/api/v1/maintenance*)
 * - Communication (/api/v1/message*, /api/v1/document*)
 * - Dashboard and community features (/api/v1/dashboard*, /api/v1/community*, /api/v1/hoa*)
 */
const applyHOADataIsolationToRoutes = (app) => {
  // Routes that need HOA data isolation
  const protectedRoutes = [
    '/api/v1/property*',
    '/api/v1/properties*',
    '/api/v1/owner*',
    '/api/v1/owners*',
    '/api/v1/tenant*',
    '/api/v1/tenants*',
    '/api/v1/expense*',
    '/api/v1/expenses*',
    '/api/v1/invoice*',
    '/api/v1/invoices*',
    '/api/v1/income*',
    '/api/v1/maintenance*',
    '/api/v1/message*',
    '/api/v1/messages*',
    '/api/v1/document*',
    '/api/v1/documents*',
    '/api/v1/dashboard*',
    '/api/v1/community*',
    '/api/v1/hoa*'
  ];

  // Apply middleware to all protected routes
  protectedRoutes.forEach(route => {
    app.use(route, hoaDataIsolation);
  });
};

/**
 * Service wrapper to pass user context to service methods
 * 
 * This higher-order function wraps service methods to automatically extract
 * and pass HOA user context from the request object. This ensures that:
 * - Service methods receive the necessary user context for data filtering
 * - HOA Board Member restrictions are consistently applied
 * - Error handling is centralized
 * 
 * Usage:
 * ```javascript
 * const wrappedService = withHOAContext(originalServiceMethod);
 * router.get('/endpoint', wrappedService);
 * ```
 * 
 * @param {Function} serviceMethod - Original service method to wrap
 * @returns {Function} - Wrapped service method with HOA context
 */
const withHOAContext = (serviceMethod) => {
  return async (req, res, next) => {
    try {
      const userContext = req.hoaContext || null;
      const safeReqData = {
        params: req.params,
        query: req.query,
        body: req.body,
        userId: req.user && req.user.id ? String(req.user.id) : null,
      };
      const result = await serviceMethod(safeReqData, res, userContext);
      return result;
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Controller helper to ensure HOA data isolation in responses
 * 
 * This function filters response data to ensure HOA Board Members only receive
 * data they own or have access to. It handles both array and object responses:
 * 
 * For Arrays:
 * - Filters each item based on ownership fields (createdBy, hoaBoardMemberId, landlord_id)
 * - Returns only items that belong to the current HOA Board Member
 * 
 * For Objects:
 * - Checks ownership and returns the object if accessible, null otherwise
 * 
 * Non-HOA users receive unfiltered data as normal.
 * 
 * Usage:
 * ```javascript
 * const result = await service.getData();
 * const filteredResult = filterResponseForHOA(result.data, req.hoaContext);
 * res.json({ ...result, data: filteredResult });
 * ```
 * 
 * @param {Array|Object} data - Response data to filter
 * @param {Object} userContext - HOA user context with role and ID information
 * @returns {Array|Object|null} - Filtered data based on HOA ownership
 */
const filterResponseForHOA = (data, userContext) => {
  if (!userContext || !userContext.isHOABoardMember) {
    return data;
  }

  const uid = (userContext.userId && userContext.userId.toString) ? userContext.userId.toString() : String(userContext.userId);
  const hoaId = userContext.hoaId ? (userContext.hoaId.toString ? userContext.hoaId.toString() : String(userContext.hoaId)) : null;
  const memberSet = new Set(
    (userContext.hoaMemberUserIds && userContext.hoaMemberUserIds.length
      ? userContext.hoaMemberUserIds
      : [uid]).map((id) => (id && id.toString ? id.toString() : String(id)))
  );

  const canSee = (item) => {
    if (!item) return false;
    if (hoaId && item.hoaId && item.hoaId.toString() === hoaId) return true;
    if (item.landlord_id && memberSet.has(item.landlord_id.toString())) return true;
    if (item.createdBy && memberSet.has(item.createdBy.toString())) return true;
    if (item.hoaBoardMemberId && memberSet.has(item.hoaBoardMemberId.toString())) return true;
    return false;
  };

  if (Array.isArray(data)) {
    return data.filter(canSee);
  }

  if (data && typeof data === 'object') {
    return canSee(data) ? data : null;
  }

  return data;
};

module.exports = {
  applyHOADataIsolationToRoutes,
  withHOAContext,
  filterResponseForHOA
};