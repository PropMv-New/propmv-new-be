/**
 * ------------------------------------------------------------------
 * File: index.js
 * Module: HOA Board Portal
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
const authMiddleware = require('../../middleware/auth');
const { hoaDataIsolation } = require('../../middleware/hoaDataIsolation');
const { enforceHoaTrialAccess } = require('../../middleware/hoaTrialAccess');
const { hoaApiResponseTimingMiddleware } = require('../../middleware/hoaApiResponseTiming');
const userProfileRoutes = require('../../shared/modules/users/routes/userProfile.routes');
const maintenanceRoutes = require('../../shared/modules/maintenance/routes/maintenance.routes');
const messagingRoutes = require('../../shared/messaging/routes/message.routes');
const emailRoutes = require('../../shared/modules/email/routes/email.routes');

router.use(hoaApiResponseTimingMiddleware);

// Enforce active HOA membership for all board-member API calls except membership + profile.
// authMiddleware MUST run before hoaDataIsolation so req.userId is set (route-level auth runs after this file's order).
router.use((req, res, next) => {
  const p = (req.path || '').split('?')[0];
  if (p.startsWith('/board-members') || p.startsWith('/users')) {
    return next();
  }
  return authMiddleware(req, res, () => hoaDataIsolation(req, res, () => enforceHoaTrialAccess(req, res, next)));
});

// Dynamically load all HOA board module routes
const modulesPath = path.join(__dirname, 'modules');
/** HOA does not expose landlord leasing/tenant-setup APIs - models may remain for legacy refs. */
// `hoa` is mounted explicitly at /board-members (not /hoa/hoa) to avoid duplicate surfaces.
const DISABLED_HOA_MODULE_ROUTES = new Set(['leasing', 'tenants', 'hoa']);

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const SAFE_FILE_RE = /^[a-zA-Z0-9_.-]+\.js$/;

if (fs.existsSync(modulesPath)) {
  fs.readdirSync(modulesPath).forEach((moduleDir) => {
    if (!SAFE_NAME_RE.test(moduleDir)) return;
    if (DISABLED_HOA_MODULE_ROUTES.has(moduleDir)) {
      return;
    }
    const routePath = path.join(modulesPath, moduleDir, 'routes');
    if (fs.existsSync(routePath)) {
      // Check for index.js first
      const indexPath = path.join(routePath, 'index.js');
      if (fs.existsSync(indexPath)) {
        const resolvedIndex = path.resolve(indexPath);
        if (!resolvedIndex.startsWith(modulesPath + path.sep)) return;
        const routes = require(resolvedIndex);
        const mountSegment = moduleDir.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!mountSegment) return;
        router.use(`/${mountSegment}`, routes);
      } else {
        // Load individual route files
        // Prefer canonical route files; skip sibling routers that would collide on the same prefix
        // (e.g. expense.routes.js already owns /payees - do not also mount payee.routes.js at /expense).
        const SKIP_AUTOLOAD_ROUTE_FILES = new Set(['payee.routes.js']);
        const routeFiles = fs
          .readdirSync(routePath)
          .filter((file) => SAFE_FILE_RE.test(file) && !SKIP_AUTOLOAD_ROUTE_FILES.has(file));
        routeFiles.forEach((file) => {
          const resolvedFile = path.resolve(routePath, file);
          if (!resolvedFile.startsWith(modulesPath + path.sep)) return;
          const routes = require(resolvedFile);
          const mountSegment = moduleDir.replace(/[^a-zA-Z0-9_-]/g, '');
          if (!mountSegment) return;
          router.use(`/${mountSegment}`, routes);
        });
      }
    }
  });
}

router.use('/users', userProfileRoutes);
router.use('/maintenance', maintenanceRoutes);
// Messaging and Email routes with HOA context middleware
router.use('/messaging', authMiddleware, (req, res, next) => hoaDataIsolation(req, res, () => enforceHoaTrialAccess(req, res, next)), messagingRoutes);
router.use('/email', authMiddleware, (req, res, next) => hoaDataIsolation(req, res, () => enforceHoaTrialAccess(req, res, next)), emailRoutes);

// HOA organization & membership routes
// Mounted at /api/v1/hoa/board-members (portal base is /api/v1/hoa)
router.use('/board-members', require('./modules/hoa/routes/hoa.routes'));

module.exports = router;
