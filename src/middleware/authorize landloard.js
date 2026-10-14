/**
 * ------------------------------------------------------------------
 * File: authorize landloard.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for authorize landloard.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Authorization middleware for access control
// Usage: Place this middleware after authentication in your route definitions

// User profile service is shared across all portals
const userProfileService = require('../shared/modules/users/services/userProfile.service');
const { getRequiredPrivilegesForRoute } = require('./apiPrivilegeCheck');

// Import all privilege definition files for each module
const authRoutePrivileges = require('../privileges/auth/auth.routes');
const usersRoutePrivileges = require('../privileges/users/users.routes');
const rolesRoutePrivileges = require('../privileges/auth/roles.routes');
const functionsRoutePrivileges = require('../privileges/auth/functions.routes');
const propertyRoutePrivileges = require('../privileges/property/property.routes');
const masterRoutePrivileges = require('../privileges/master/masterData.routes');
const tenantsRoutePrivileges = require('../privileges/tenants/tenants.routes');
const leasingRoutePrivileges = require('../privileges/leasing/leases.routes');
const maintenanceRoutePrivileges = require('../privileges/maintenance/maintenance.routes');
const applicationRoutePrivileges = require('../privileges/application/application.routes');
const dashboardRoutePrivileges = require('../privileges/dashboard/dashboard.routes');
const incomeRoutePrivileges = require('../privileges/income/income.routes');
const eventsRoutePrivileges = require('../privileges/events/events.routes');
const listingRoutePrivileges = require('../privileges/listing/listing.routes');
const tenantScreeningSettingsRoutePrivileges = require('../privileges/tenantScreeningSettings/tenantScreeningSettings.routes');

// Helper to get required privileges for the current route
function getRequiredPrivileges(req) {
  // compose a method-aware key first: "GET /api/v1/path/:id"
  const routePath = req.route && req.route.path ? (req.baseUrl || '') + req.route.path : req.originalUrl;
  const methodKey = `${(req.method || 'GET').toUpperCase()} ${routePath}`;

  // Try to match method+path in each route map first
  const maps = [
    authRoutePrivileges,
    usersRoutePrivileges,
    rolesRoutePrivileges,
    functionsRoutePrivileges,
    propertyRoutePrivileges,
    masterRoutePrivileges,
    tenantsRoutePrivileges,
    leasingRoutePrivileges,
    maintenanceRoutePrivileges,
    applicationRoutePrivileges,
    dashboardRoutePrivileges,
    incomeRoutePrivileges,
    eventsRoutePrivileges,
    listingRoutePrivileges,
    tenantScreeningSettingsRoutePrivileges
  ];
  
  const requiredPrivileges = getRequiredPrivilegesForRoute(req.method, routePath, maps);
  return requiredPrivileges;
}

// Authorization middleware
async function authorize(req, res, next) {
  try {
    // Get userId from token (set by authentication middleware)
    const userId = req.userId || (req.user && req.user.id);
    if (!userId) {
      return res.status(401).json({ message: 'User not authenticated' });
    }
    
    // Fetch user's privileges/functions
    const { privileges } = await userProfileService.getPrivileges(userId);
    
    // Store privileges in request for use by checkApiPrivilege middleware
    req.userPrivileges = privileges || [];
    
    // TEMPORARY BYPASS: During initial setup many users/roles may not have
    // privileges assigned. If the fetched privileges array is empty, skip
    // authorization checks and allow the request. Remove this bypass once
    // privileges are populated for APIs.
    if (!privileges || privileges.length === 0) {
      return next();
    }
    
    // Get required privileges for this route
    const requiredPrivileges = getRequiredPrivileges(req);
    
    // If no required privileges specified, allow access
    if (!requiredPrivileges || requiredPrivileges.length === 0) {
      return next();
    }
    
    // Check if user has at least one required privilege (OR logic)
    // This allows APIs to have multiple acceptable privileges
    const hasAccess = requiredPrivileges.some(requiredPriv => 
      privileges.includes(requiredPriv)
    );
    
    if (!hasAccess) {
      return res.status(403).json({ 
        message: 'Authorization failed: insufficient privileges',
        statuscode: 403,
        data: null
      });
    }
    
    next();
  } catch (err) {
    return res.status(403).json({ 
      message: 'Authorization failed',
      statuscode: 403,
      data: null
    });
  }
}

module.exports = authorize;
