/**
 * ------------------------------------------------------------------
 * File: ruleMatcher.js
 * Module: Backend Middleware
 *
 * Purpose:
 * Backend utility/module providing helper functions for ruleMatcher.
 *
 * Used By:
 * apiRateLimit.middleware
 * ------------------------------------------------------------------
 */
const rateLimitConfig = require('../../config/rateLimit.config');

/**
 * get Path
 *
 * Performs logic operations for getPath.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function getPath(req) {
  return (req.originalUrl || req.url || '').split('?')[0].toLowerCase();
}

/**
 * get Method
 *
 * Performs logic operations for getMethod.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function getMethod(req) {
  return String(req.method || 'GET').toUpperCase();
}

/**
 * is Api Path
 *
 * Performs logic operations for isApiPath.
 *
 * @param path - Request/input argument
 * @returns Operations result
 */
function isApiPath(path) {
  return path.startsWith('/api/');
}

/**
 * is Exempt Path
 *
 * Performs logic operations for isExemptPath.
 *
 * @param path - Request/input argument
 * @returns Operations result
 */
function isExemptPath(path) {
  if (path.startsWith('/api/webhooks')) return true;
  if (path.startsWith('/api/v1/system/email-bounces')) return true;
  if (path.startsWith('/api/v1/system/email-suppressions')) return true;
  if (path.startsWith('/api-docs')) return true;
  if (path.startsWith('/swagger')) return true;
  return false;
}

/**
 * is Public Auth Path
 *
 * Performs logic operations for isPublicAuthPath.
 *
 * @param path - Request/input argument
 * @returns Operations result
 */
function isPublicAuthPath(path) {
  const publicAuthPaths = [
    '/api/v1/auth/signup',
    '/api/v1/auth/login',
    '/api/v1/auth/check-identity',
    '/api/v1/auth/forgot-password',
    '/api/v1/auth/verify-reset-otp',
    '/api/v1/auth/verify-otp-reset-password',
    '/api/v1/auth/send-mfa-otp',
    '/api/v1/auth/verify-mfa-otp',
    '/api/v1/auth/refresh-token',
    '/api/v1/auth/refresh',
    '/api/v1/auth/portal-invite/validate',
    '/api/v1/auth/portal-invite/complete',
    '/api/v1/auth/public/masterdata',
  ];
  return publicAuthPaths.some((entry) => path === entry || path.startsWith(`${entry}/`));
}

/**
 * is Authenticated Request
 *
 * Performs logic operations for isAuthenticatedRequest.
 *
 * @param req - Request/input argument
 * @returns Operations result
 */
function isAuthenticatedRequest(req) {
  if (req.userId) return true;
  const authHeader = req.headers?.authorization;
  return Boolean(authHeader && authHeader.startsWith('Bearer '));
}

/**
 * is Bulk Upload Request
 *
 * Performs logic operations for isBulkUploadRequest.
 *
 * @param method - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function isBulkUploadRequest(method, path) {
  return method === 'POST' && (/\/import(?:\/|$)/.test(path) || path.endsWith('/import'));
}

/**
 * is File Upload Request
 *
 * Performs logic operations for isFileUploadRequest.
 *
 * @param method - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function isFileUploadRequest(method, path) {
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
    return false;
  }
  if (isBulkUploadRequest(method, path)) {
    return false;
  }

  const uploadPatterns = [
    /\/upload(?:\/|$|-)/,
    /\/upload-attachments/,
    /\/documents\/hoa\/upload/,
    /\/documents\/upload/,
    /\/messaging\/upload/,
    /\/document(?:s)?(?:\/|$)/,
    /\/images(?:\/|$)/,
    /\/picture\//,
    /\/maintenance(?:\/|$)/,
    /\/damage-report/,
    /\/expense(?:\/|$)/,
    /\/listing(?:\/|$)/,
    /\/invoice(?:\/|$)/,
    /\/lease\/[^/]+\/document/,
    /\/tenants\/[^/]+\/documents/,
    /\/email\/send/,
    /\/email\/draft\/save/,
  ];

  return uploadPatterns.some((pattern) => pattern.test(path));
}

/**
 * is Search Request
 *
 * Performs logic operations for isSearchRequest.
 *
 * @param method - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function isSearchRequest(method, path) {
  if (method !== 'GET') return false;
  return (
    /\/search(?:\/|$)/.test(path)
    || /\/contacts(?:\/|$)/.test(path)
    || /\/messaging\/contacts/.test(path)
  );
}

/**
 * is Role Permission Request
 *
 * Performs logic operations for isRolePermissionRequest.
 *
 * @param method - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function isRolePermissionRequest(method, path) {
  return (
    /\/api\/v1\/company\/[^/]+\/roles/.test(path)
    && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
  );
}

/**
 * is User Management Request
 *
 * Performs logic operations for isUserManagementRequest.
 *
 * @param method - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function isUserManagementRequest(method, path) {
  if (!path.startsWith('/api/v1/users')) return false;
  if (method === 'POST' && (path === '/api/v1/users' || path === '/api/v1/users/batch')) return true;
  if (method === 'DELETE' && /^\/api\/v1\/users\/[^/]+$/.test(path)) return true;
  if (method === 'PATCH' && /\/activate$/.test(path)) return true;
  if (method === 'POST' && /\/send-invite$/.test(path)) return true;
  if (method === 'PUT' && path === '/api/v1/users/role') return true;
  return false;
}

/**
 * is Update Profile Request
 *
 * Performs logic operations for isUpdateProfileRequest.
 *
 * @param method - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function isUpdateProfileRequest(method, path) {
  if (method === 'PUT' && /^\/api\/v1\/users\/[^/]+$/.test(path)) return true;
  if (method === 'PUT' && /^\/api\/v1\/users\/picture\//.test(path)) return true;
  return false;
}

/**
 * is Get Profile Request
 *
 * Performs logic operations for isGetProfileRequest.
 *
 * @param method - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function isGetProfileRequest(method, path) {
  return method === 'GET' && (path === '/api/v1/users' || /^\/api\/v1\/users\/[^/]+$/.test(path));
}

/**
 * is List Users Request
 *
 * Performs logic operations for isListUsersRequest.
 *
 * @param method - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function isListUsersRequest(method, path) {
  return method === 'GET' && path === '/api/v1/users/list';
}

function isNotificationRequest(method, path) {
  if (!path.startsWith('/api/v1/notifications')) return false;
  if (method === 'GET') return true;
  if (method === 'PATCH' && /^\/api\/v1\/notifications\/[^/]+\/read$/.test(path)) return true;
  if (method === 'POST' && (
    path === '/api/v1/notifications/mark-read'
    || path === '/api/v1/notifications/mark-all-read'
  )) {
    return true;
  }
  return false;
}

/**
 * is Admin Operations Request
 *
 * Performs logic operations for isAdminOperationsRequest.
 *
 * @param method - Request/input argument
 * @param path - Request/input argument
 * @returns Operations result
 */
function isAdminOperationsRequest(method, path) {
  if (!path.startsWith('/api/v1/company')) return false;
  if (isRolePermissionRequest(method, path)) return false;
  return method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function isOwnerCreateInviteRequest(method, path) {
  return method === 'POST' && (
    path === '/api/v1/hoa/owners' ||
    path === '/api/v1/owners'
  );
}

function isOwnerResendInviteRequest(method, path) {
  return method === 'POST' && /\/owners\/[^/]+\/resend-invite$/.test(path);
}

/**
 * Returns ordered rate-limit rules to evaluate for a request.
 * Most specific rules first; multiple rules can apply (e.g. OTP cooldown + send limit).
 * @returns {Array<{name: string, limit: number, windowMs: number, keyType: string}>}
 */
function resolveRateLimitRules(req) {
  const path = getPath(req);
  const method = getMethod(req);

  if (!isApiPath(path) || isExemptPath(path)) {
    return [];
  }

  const rules = [];

  // --- Owner invitation / verification emails (SMTP reputation) ---
  if (isOwnerResendInviteRequest(method, path)) {
    rules.push({
      name: 'email-invite:resend',
      ...rateLimitConfig.emailInvite.resendInvite,
      keyType: 'user',
    });
    return rules;
  }
  if (isOwnerCreateInviteRequest(method, path)) {
    rules.push({
      name: 'email-invite:create-owner',
      ...rateLimitConfig.emailInvite.createOwner,
      keyType: 'user',
    });
    return rules;
  }

  // --- Authentication (exact paths) ---
  if (path === '/api/v1/auth/signup' && method === 'POST') {
    rules.push({ name: 'auth:signup', ...rateLimitConfig.auth.signup, keyType: 'ip' });
    return rules;
  }
  if (path === '/api/v1/auth/login' && method === 'POST') {
    rules.push({ name: 'auth:login', ...rateLimitConfig.auth.login, keyType: 'userIp' });
    return rules;
  }
  if (path === '/api/v1/auth/send-mfa-otp' && method === 'POST') {
    rules.push({ name: 'auth:send-otp', ...rateLimitConfig.auth.sendOtp, keyType: 'email' });
    return rules;
  }
  if (path === '/api/v1/auth/verify-mfa-otp' && method === 'POST') {
    rules.push({ name: 'auth:verify-otp', ...rateLimitConfig.auth.verifyOtp, keyType: 'email' });
    return rules;
  }
  if (path === '/api/v1/auth/forgot-password' && method === 'POST') {
    rules.push({ name: 'auth:forgot-password', ...rateLimitConfig.auth.forgotPassword, keyType: 'email' });
    return rules;
  }
  if (path === '/api/v1/auth/verify-reset-otp' && method === 'POST') {
    rules.push({ name: 'auth:verify-reset-otp', ...rateLimitConfig.auth.verifyOtp, keyType: 'email' });
    return rules;
  }
  if (path === '/api/v1/auth/verify-otp-reset-password' && method === 'PUT') {
    rules.push({ name: 'auth:reset-password', ...rateLimitConfig.auth.resetPassword, keyType: 'email' });
    return rules;
  }
  if (path === '/api/v1/auth/reset-password' && method === 'PUT') {
    rules.push({ name: 'auth:reset-password', ...rateLimitConfig.auth.resetPassword, keyType: 'user' });
    return rules;
  }
  if (
    (path === '/api/v1/auth/refresh-token' && method === 'GET')
    || (path === '/api/v1/auth/refresh' && method === 'POST')
  ) {
    rules.push({ name: 'auth:refresh-token', ...rateLimitConfig.auth.refreshToken, keyType: 'user' });
    return rules;
  }
  if (path === '/api/v1/auth/logout' && method === 'POST') {
    rules.push({ name: 'auth:logout', ...rateLimitConfig.auth.logout, keyType: 'user' });
    return rules;
  }
  if (path === '/api/v1/payments/verify-account/send-otp' && method === 'POST') {
    rules.push({ name: 'auth:send-otp', ...rateLimitConfig.auth.sendOtp, keyType: 'user' });
    return rules;
  }

  // --- Upload tiers ---
  if (isBulkUploadRequest(method, path)) {
    rules.push({ name: 'upload:bulk', ...rateLimitConfig.upload.bulk, keyType: 'user' });
    return rules;
  }
  if (isFileUploadRequest(method, path)) {
    rules.push({ name: 'upload:file', ...rateLimitConfig.upload.file, keyType: 'user' });
    return rules;
  }

  // --- User API tiers ---
  if (isListUsersRequest(method, path)) {
    rules.push({ name: 'user:list', ...rateLimitConfig.user.listUsers, keyType: 'user' });
    return rules;
  }
  if (isGetProfileRequest(method, path)) {
    rules.push({ name: 'user:get-profile', ...rateLimitConfig.user.getProfile, keyType: 'user' });
    return rules;
  }
  if (isUpdateProfileRequest(method, path)) {
    rules.push({ name: 'user:update-profile', ...rateLimitConfig.user.updateProfile, keyType: 'user' });
    return rules;
  }
  if (isSearchRequest(method, path)) {
    rules.push({ name: 'user:search', ...rateLimitConfig.user.searchUsers, keyType: 'user' });
    return rules;
  }

  // --- Admin tiers ---
  if (isRolePermissionRequest(method, path)) {
    rules.push({ name: 'admin:role-permission', ...rateLimitConfig.admin.rolePermission, keyType: 'user' });
    return rules;
  }
  if (isUserManagementRequest(method, path)) {
    rules.push({ name: 'admin:user-management', ...rateLimitConfig.admin.userManagement, keyType: 'user' });
    return rules;
  }
  if (isAdminOperationsRequest(method, path)) {
    rules.push({ name: 'admin:operations', ...rateLimitConfig.admin.operations, keyType: 'user' });
    return rules;
  }

  // --- Public unauthenticated endpoints ---
  if (isPublicAuthPath(path) && !isAuthenticatedRequest(req)) {
    rules.push({ name: 'public:endpoints', ...rateLimitConfig.public.endpoints, keyType: 'ip' });
    return rules;
  }

  // Zillow / syndication public API paths under /api/
  if (path.includes('/zillow') || path.includes('/syndication')) {
    rules.push({ name: 'public:endpoints', ...rateLimitConfig.public.endpoints, keyType: 'ip' });
    return rules;
  }

  // --- In-app notifications (personal; separate from CRUD GET bucket) ---
  if (isNotificationRequest(method, path) && isAuthenticatedRequest(req)) {
    if (method === 'GET') {
      rules.push({
        name: 'notifications:get',
        ...rateLimitConfig.notifications.get,
        keyType: 'user',
      });
    } else {
      rules.push({
        name: 'notifications:write',
        ...rateLimitConfig.notifications.write,
        keyType: 'user',
      });
    }
    return rules;
  }

  // --- Authenticated CRUD fallback ---
  if (isAuthenticatedRequest(req) && path.startsWith('/api/v1/')) {
    if (method === 'GET') {
      rules.push({ name: 'crud:get', ...rateLimitConfig.crud.get, keyType: 'user' });
    } else if (method === 'POST') {
      rules.push({ name: 'crud:post', ...rateLimitConfig.crud.post, keyType: 'user' });
    } else if (method === 'PUT' || method === 'PATCH') {
      rules.push({ name: 'crud:put-patch', ...rateLimitConfig.crud.putPatch, keyType: 'user' });
    } else if (method === 'DELETE') {
      rules.push({ name: 'crud:delete', ...rateLimitConfig.crud.delete, keyType: 'user' });
    }
    return rules;
  }

  // Unauthenticated API calls not matched above
  if (path.startsWith('/api/')) {
    rules.push({ name: 'public:endpoints', ...rateLimitConfig.public.endpoints, keyType: 'ip' });
  }

  return rules;
}

module.exports = {
  resolveRateLimitRules,
  getPath,
  isExemptPath,
};
