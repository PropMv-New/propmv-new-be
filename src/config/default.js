/**
 * ------------------------------------------------------------------
 * File: default.js
 * Module: Src Config
 *
 * Purpose:
 * Backend utility/module providing helper functions for default.
 *
 * Used By:
 * test-s3-implementation, app, uploads, uploadHelper
 * ------------------------------------------------------------------
 */

module.exports = {
  port: process.env.PORT || 3000,
  profile: process.env.APP_PROFILE || 'local',
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshSecret: process.env.REFRESH_TOKEN_SECRET
  },
  db: {
    url: process.env.DB_URL
  },
  redis: {
    url: process.env.REDIS_URL
  },
  thirdParty: {
    stripe: { secret: process.env.STRIPE_SECRET_KEY },
    docusign: { integratorKey: process.env.DOCUSIGN_INTEGRATOR_KEY },
    plaid: { clientId: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET },
    zillow: require('../integrations/syndication/zillow/zillow.config'),
  }
  ,
  /**
   * Object storage configuration.
   * STORAGE_PROVIDER=s3 | azure | mock
   * When unset, falls back to MOCKS3=true → mock, otherwise s3 (if S3_BUCKET set) or mock.
   */
  storage: {
    provider: (process.env.STORAGE_PROVIDER || '').toString().trim().toLowerCase() || null,
    azure: {
      accountName: process.env.AZURE_STORAGE_ACCOUNT_NAME || null,
      accountKey: process.env.AZURE_STORAGE_ACCOUNT_KEY || null,
      connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || null,
      container: process.env.AZURE_STORAGE_CONTAINER || null,
      baseUrl: process.env.AZURE_STORAGE_BASE_URL || null,
    },
  },
  s3: {
    // Control whether to use mock S3. Set MOCKS3=true in your .env for local development.
    // Also selected when STORAGE_PROVIDER=mock.
    useMock: (process.env.MOCKS3 || process.env.MOCK_S3 || process.env.S3_USE_MOCK || '').toString().toLowerCase() === 'true'
      || (process.env.STORAGE_PROVIDER || '').toString().trim().toLowerCase() === 'mock',
    // baseUrl: public URL prefix for served files (set in .env as S3_BASE_URL)
    baseUrl: (() => {
      const raw = process.env.S3_BASE_URL || process.env.AZURE_STORAGE_BASE_URL || '';
      if (!raw) return '/mock-s3';
      // Never treat localhost/mock URLs as cloud public base when using real S3
      if (/localhost|127\.0\.0\.1|\/mock-s3/i.test(raw)) {
        return process.env.STORAGE_PROVIDER === 'mock' || (process.env.MOCKS3 || '').toLowerCase() === 'true'
          ? raw
          : '';
      }
      return raw;
    })(),
    // local folder used by mock implementation (always absolute; relative S3_MOCK_DIR is cwd-resolved)
    mockDir: require('path').resolve(
      process.env.S3_MOCK_DIR || require('path').join(__dirname, '../../mock_s3')
    ),
    // AWS S3 configuration (also used as DocumentMetadata.bucketName for Azure = container name)
    bucket: process.env.S3_BUCKET || process.env.AZURE_STORAGE_CONTAINER || 'propmv-docs',
    // Alias used by some legacy services that read config.s3.bucketName
    bucketName: process.env.S3_BUCKET || process.env.AZURE_STORAGE_CONTAINER || 'propmv-docs',
    region: process.env.AWS_REGION || 'us-east-1',
    // Optional: Map logical document types to folder prefixes in the bucket.
    // You can override this mapping with the S3_UPLOAD_FOLDERS environment variable (JSON string)
    // Example mapping: { "property":"properties", "tenant":"tenant-documents", "profile":"profile-pictures" }
    uploadFolders: {
      property: process.env.S3_UPLOAD_FOLDER_PROPERTY || 'Property',
      tenant: process.env.S3_UPLOAD_FOLDER_TENANT || 'Tenants',
      profile: process.env.S3_UPLOAD_FOLDER_PROFILE || 'profile-pictures',
      lease: process.env.S3_UPLOAD_FOLDER_LEASE || 'Lease & files',
      application: process.env.S3_UPLOAD_FOLDER_APPLICATION || 'Applications',
      invoice: process.env.S3_UPLOAD_FOLDER_INVOICE || 'invoice-documents',
      income: process.env.S3_UPLOAD_FOLDER_INCOME || 'Income',
      expense: process.env.S3_UPLOAD_FOLDER_EXPENSE || 'Expense',
      maintenance: process.env.S3_UPLOAD_FOLDER_MAINTENANCE || 'Maintenance',
      message: process.env.S3_UPLOAD_FOLDER_MESSAGE || 'Messaging',
      email: process.env.S3_UPLOAD_FOLDER_EMAIL || 'Email',
      listing: process.env.S3_UPLOAD_FOLDER_LISTING || 'Listings',
      damageReport: process.env.S3_UPLOAD_FOLDER_DAMAGE_REPORT || 'damage-reports',
      hoa: process.env.S3_UPLOAD_FOLDER_HOA || 'HOA Documents',
    }
  }
  ,
  uploads: {
    // Base directory for temporary uploads (relative paths are resolved at runtime)
    base: process.env.UPLOAD_DIR_BASE || require('path').join(__dirname, '../../uploads'),
    // Subdirectories for specific upload types
    propertySubdir: process.env.UPLOAD_PROPERTY_SUBDIR,
    // lease documents subdir env var
    leaseSubdir: process.env.UPLOAD_LEASE_SUBDIR,
    tenantSubdir: process.env.UPLOAD_TENANT_SUBDIR,
    profileSubdir: process.env.UPLOAD_PROFILE_SUBDIR,
    invoiceSubdir: process.env.UPLOAD_INVOICE_SUBDIR,
    maintenanceSubdir: process.env.UPLOAD_MAINTENANCE_SUBDIR,
    damageReportSubdir: process.env.UPLOAD_DAMAGE_REPORT_SUBDIR
  },
  timezone: {
    app: process.env.APP_TIMEZONE || 'America/New_York',
    mongoDateExpr: process.env.HOA_MONGO_TIMEZONE || 'America/New_York',
    label: process.env.APP_TIMEZONE_LABEL || 'US Eastern (America/New_York)',
  },
  hoa: {
    /** Hours until an emailed HOA board-member invite link expires (HOA_BOARD_INVITE_EXPIRY_HOURS). */
    boardInviteExpiryHours: Number(process.env.HOA_BOARD_INVITE_EXPIRY_HOURS || 48),
  },
  session: {
    idleTimeoutMinutes: Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES || 30),
    mfaValidityHours: Number(
      process.env.MFA_SESSION_VALIDITY_HOURS ||
        process.env.MFA_LOGIN_WINDOW_HOURS ||
        6
    ),
    /** Days a device remains trusted after OTP + "Trust this device" */
    trustedDeviceDays: Number(process.env.MFA_TRUSTED_DEVICE_DAYS || 30),
    /** HMAC secret for device fingerprints; falls back to JWT_SECRET if unset */
    deviceFingerprintSecret: process.env.DEVICE_FINGERPRINT_SECRET || null,
  },
  /**
   * Reverse-proxy trust. See config/trustProxy.js.
   * Deployed profiles default to 1 hop; override with TRUST_PROXY.
   */
  trustProxy: require('./trustProxy').resolveTrustProxySetting().setting,
  /** Tiered API / feature rate limits - all values overridable via RATE_LIMIT_* env vars. */
  rateLimit: require('./rateLimit.config'),
};
