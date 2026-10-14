require('../../../../config/loadEnv');
const jwt = require('jsonwebtoken');
const config = require('../../../../config/default');

/**
 * Optional authentication middleware for public endpoints.
 *
 * If a valid Bearer token is provided, populates `req.userId` and `req.user`.
 * If no token is provided, or if the token is invalid/expired, passes through
 * without blocking so public and anonymous requests continue to function normally.
 */
function optionalAuth(req, res, next) {
  // If prior middleware already resolved the user, proceed
  if (req.userId) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || config.jwt.secret);
    if (decoded && decoded.sub) {
      req.userId = decoded.sub;
      req.user = {
        _id: decoded.sub,
        id: decoded.sub,
        role: decoded.role,
      };
    }
  } catch (_err) {
    // Malformed or expired token on public route: proceed as anonymous guest
  }

  next();
}

module.exports = optionalAuth;
