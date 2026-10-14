/**
 * ------------------------------------------------------------------
 * File: rateLimit.config.js
 * Module: Src Config
 *
 * Purpose:
 * Configuration settings, variables mapping, and constants definitions.
 *
 * Used By:
 * apiRateLimit.middleware, ruleMatcher, rateLimit.service
 * ------------------------------------------------------------------
 */

/**
 * Central API / feature rate-limit configuration.
 * Every limit and window is overridable via environment variables.
 */
function intEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * ms From Minutes
 *
 * Performs logic operations for msFromMinutes.
 *
 * @param minutes - Request/input argument
 * @param envName - Request/input argument
 * @returns Operations result
 */
function msFromMinutes(minutes, envName) {
  return intEnv(envName, minutes) * 60 * 1000;
}

/**
 * ms From Seconds
 *
 * Performs logic operations for msFromSeconds.
 *
 * @param seconds - Request/input argument
 * @param envName - Request/input argument
 * @returns Operations result
 */
function msFromSeconds(seconds, envName) {
  return intEnv(envName, seconds) * 1000;
}

function parsePositiveIntList(name, fallback) {
  const raw = process.env[name];
  if (!raw || !String(raw).trim()) return fallback.slice();
  const parsed = String(raw)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return parsed.length > 0 ? parsed : fallback.slice();
}

const rateLimitConfig = {
  /** Set RATE_LIMIT_ENABLED=false to turn rate limiting off. */
  enabled: process.env.RATE_LIMIT_ENABLED !== 'false',

  auth: {
    signup: {
      limit: intEnv('RATE_LIMIT_AUTH_SIGNUP_LIMIT', 5),
      windowMs: msFromMinutes(15, 'RATE_LIMIT_AUTH_SIGNUP_WINDOW_MINUTES'),
    },
    login: {
      limit: intEnv('RATE_LIMIT_AUTH_LOGIN_LIMIT', 10),
      windowMs: msFromMinutes(15, 'RATE_LIMIT_AUTH_LOGIN_WINDOW_MINUTES'),
    },
    sendOtp: {
      limit: intEnv('RATE_LIMIT_AUTH_SEND_OTP_LIMIT', 4),
      windowMs: msFromMinutes(15, 'RATE_LIMIT_AUTH_SEND_OTP_WINDOW_MINUTES'),
    },
    verifyOtp: {
      limit: intEnv('RATE_LIMIT_AUTH_VERIFY_OTP_LIMIT', 10),
      windowMs: msFromMinutes(10, 'RATE_LIMIT_AUTH_VERIFY_OTP_WINDOW_MINUTES'),
    },
    forgotPassword: {
      limit: intEnv('RATE_LIMIT_AUTH_FORGOT_PASSWORD_LIMIT', 5),
      windowMs: msFromMinutes(30, 'RATE_LIMIT_AUTH_FORGOT_PASSWORD_WINDOW_MINUTES'),
    },
    resetPassword: {
      limit: intEnv('RATE_LIMIT_AUTH_RESET_PASSWORD_LIMIT', 5),
      windowMs: msFromMinutes(30, 'RATE_LIMIT_AUTH_RESET_PASSWORD_WINDOW_MINUTES'),
    },
    refreshToken: {
      limit: intEnv('RATE_LIMIT_AUTH_REFRESH_TOKEN_LIMIT', 60),
      windowMs: msFromMinutes(5, 'RATE_LIMIT_AUTH_REFRESH_TOKEN_WINDOW_MINUTES'),
    },
    logout: {
      limit: intEnv('RATE_LIMIT_AUTH_LOGOUT_LIMIT', 30),
      windowMs: msFromMinutes(5, 'RATE_LIMIT_AUTH_LOGOUT_WINDOW_MINUTES'),
    },
  },

  user: {
    getProfile: {
      limit: intEnv('RATE_LIMIT_USER_GET_PROFILE_LIMIT', 120),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_USER_GET_PROFILE_WINDOW_MINUTES'),
    },
    updateProfile: {
      limit: intEnv('RATE_LIMIT_USER_UPDATE_PROFILE_LIMIT', 30),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_USER_UPDATE_PROFILE_WINDOW_MINUTES'),
    },
    searchUsers: {
      limit: intEnv('RATE_LIMIT_USER_SEARCH_LIMIT', 60),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_USER_SEARCH_WINDOW_MINUTES'),
    },
    listUsers: {
      limit: intEnv('RATE_LIMIT_USER_LIST_LIMIT', 60),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_USER_LIST_WINDOW_MINUTES'),
    },
  },

  /**
   * In-app notifications - personal reads; separate from generic CRUD GET bucket
   * so dashboard + SSE reconnect storms do not block other API traffic.
   */
  notifications: {
    get: {
      limit: intEnv('RATE_LIMIT_NOTIFICATIONS_GET_LIMIT', 300),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_NOTIFICATIONS_GET_WINDOW_MINUTES'),
    },
    write: {
      limit: intEnv('RATE_LIMIT_NOTIFICATIONS_WRITE_LIMIT', 120),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_NOTIFICATIONS_WRITE_WINDOW_MINUTES'),
    },
  },

  crud: {
    get: {
      limit: intEnv('RATE_LIMIT_CRUD_GET_LIMIT', 120),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_CRUD_GET_WINDOW_MINUTES'),
    },
    post: {
      limit: intEnv('RATE_LIMIT_CRUD_POST_LIMIT', 60),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_CRUD_POST_WINDOW_MINUTES'),
    },
    putPatch: {
      limit: intEnv('RATE_LIMIT_CRUD_PUT_PATCH_LIMIT', 60),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_CRUD_PUT_PATCH_WINDOW_MINUTES'),
    },
    delete: {
      limit: intEnv('RATE_LIMIT_CRUD_DELETE_LIMIT', 30),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_CRUD_DELETE_WINDOW_MINUTES'),
    },
  },

  upload: {
    file: {
      limit: intEnv('RATE_LIMIT_UPLOAD_FILE_LIMIT', 10),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_UPLOAD_FILE_WINDOW_MINUTES'),
    },
    bulk: {
      limit: intEnv('RATE_LIMIT_UPLOAD_BULK_LIMIT', 3),
      windowMs: msFromMinutes(10, 'RATE_LIMIT_UPLOAD_BULK_WINDOW_MINUTES'),
    },
  },

  admin: {
    operations: {
      limit: intEnv('RATE_LIMIT_ADMIN_OPERATIONS_LIMIT', 30),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_ADMIN_OPERATIONS_WINDOW_MINUTES'),
    },
    userManagement: {
      limit: intEnv('RATE_LIMIT_ADMIN_USER_MANAGEMENT_LIMIT', 30),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_ADMIN_USER_MANAGEMENT_WINDOW_MINUTES'),
    },
    rolePermission: {
      limit: intEnv('RATE_LIMIT_ADMIN_ROLE_PERMISSION_LIMIT', 20),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_ADMIN_ROLE_PERMISSION_WINDOW_MINUTES'),
    },
  },

  public: {
    endpoints: {
      limit: intEnv('RATE_LIMIT_PUBLIC_LIMIT', 60),
      windowMs: msFromMinutes(1, 'RATE_LIMIT_PUBLIC_WINDOW_MINUTES'),
    },
  },

  /**
   * Owner portal invite / verification emails - tighter than generic CRUD POST
   * to protect SMTP reputation from accidental or abusive resends.
   */
  emailInvite: {
    createOwner: {
      limit: intEnv('RATE_LIMIT_OWNER_CREATE_INVITE_LIMIT', 20),
      windowMs: msFromMinutes(10, 'RATE_LIMIT_OWNER_CREATE_INVITE_WINDOW_MINUTES'),
    },
    resendInvite: {
      limit: intEnv('RATE_LIMIT_OWNER_RESEND_INVITE_LIMIT', 5),
      windowMs: msFromMinutes(15, 'RATE_LIMIT_OWNER_RESEND_INVITE_WINDOW_MINUTES'),
    },
  },

  /** Public marketing site endpoints (newsletter, visits, demo requests). */
  marketing: {
    subscription: {
      limit: intEnv('MARKETING_SUBSCRIPTION_RATE_LIMIT_PER_MIN', 20),
      windowMs: msFromMinutes(1, 'MARKETING_SUBSCRIPTION_RATE_LIMIT_WINDOW_MINUTES'),
    },
    visit: {
      limit: intEnv('MARKETING_VISIT_RATE_LIMIT_PER_MIN', 120),
      windowMs: msFromMinutes(1, 'MARKETING_VISIT_RATE_LIMIT_WINDOW_MINUTES'),
    },
    demoRequest: {
      limit: intEnv('MARKETING_DEMO_REQUEST_RATE_LIMIT_PER_HOUR', 5),
      windowMs: msFromMinutes(60, 'MARKETING_DEMO_REQUEST_RATE_LIMIT_WINDOW_MINUTES'),
    },
  },

  /** Public address autocomplete / usage reporting. */
  address: {
    lookup: {
      limit: intEnv('ADDRESS_RATE_LIMIT_PER_MIN', 90),
      windowMs: msFromMinutes(1, 'ADDRESS_RATE_LIMIT_WINDOW_MINUTES'),
    },
    usage: {
      limit: intEnv('ADDRESS_USAGE_RATE_LIMIT_PER_MIN', 600),
      windowMs: msFromMinutes(1, 'ADDRESS_USAGE_RATE_LIMIT_WINDOW_MINUTES'),
    },
  },

  /** Progressive OTP resend cooldowns (login / signup / forgot-password). */
  otpResend: {
    cooldownSeconds: parsePositiveIntList('OTP_RESEND_COOLDOWN_SECONDS', [30, 60, 120]),
    maxAttempts: intEnv('OTP_RESEND_MAX_ATTEMPTS', 3),
    lockoutSeconds: intEnv('OTP_RESEND_LOCKOUT_SECONDS', 300),
    stateTtlMs: msFromMinutes(15, 'OTP_RESEND_STATE_TTL_MINUTES'),
  },
};

module.exports = rateLimitConfig;
module.exports.intEnv = intEnv;
module.exports.msFromMinutes = msFromMinutes;
module.exports.msFromSeconds = msFromSeconds;
module.exports.parsePositiveIntList = parsePositiveIntList;
