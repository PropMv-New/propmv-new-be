/**
 * ------------------------------------------------------------------
 * File: rbac.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for rbac.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

// Usage: rbac(['admin', 'property_manager'])
module.exports = function allowedRoles(roles = []) {
  return (req, res, next) => {
    if (!req.user || !req.user.roles) return res.status(403).json({ message: 'Forbidden' });
    const has = req.user.roles.some(r => roles.includes(r));
    if (!has) return res.status(403).json({ message: 'Insufficient role' });
    next();
  };
};
