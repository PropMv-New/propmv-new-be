'use strict';

/**
 * Restricts routes to company Administrator users (same mechanism as marketing admin APIs).
 */
function requireAdministrator(req, res, next) {
  if (req.user?.isAdministrator === true) {
    return next();
  }
  return res.status(403).json({
    message: 'Administrator access is required.',
    statuscode: 403,
    data: null,
  });
}

module.exports = requireAdministrator;
