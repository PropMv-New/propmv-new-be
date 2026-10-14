/**
 * ------------------------------------------------------------------
 * File: ownerIdentityValidation.js
 * Module: HOA Board Portal
 *
 * Purpose:
 * Backend utility/module providing helper functions for ownerIdentityValidation.
 *
 * Used By:
 * owner.service
 * ------------------------------------------------------------------
 */

const {
  DUPLICATE_EMAIL_MESSAGE,
  DUPLICATE_PHONE_MESSAGE,
  normalizeUserEmail,
  normalizeUserPhone,
  buildReleasedUserEmail,
  releaseUserIdentity,
  releaseStaleDeletedUserEmail,
  assertUniqueUserEmail,
  assertUniqueUserPhone,
  mapUserPersistenceError,
} = require('../../../../../shared/modules/users/helpers/userIdentityValidation');

module.exports = {
  DUPLICATE_EMAIL_MESSAGE,
  DUPLICATE_PHONE_MESSAGE,
  normalizeOwnerEmail: normalizeUserEmail,
  normalizeOwnerPhone: normalizeUserPhone,
  buildReleasedOwnerEmail: buildReleasedUserEmail,
  releaseOwnerIdentity: releaseUserIdentity,
  releaseStaleDeletedOwnerEmail: releaseStaleDeletedUserEmail,
  assertUniqueOwnerEmail: assertUniqueUserEmail,
  assertUniqueOwnerPhone: assertUniqueUserPhone,
  mapOwnerPersistenceError: mapUserPersistenceError,
};
