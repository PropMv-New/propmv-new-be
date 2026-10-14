/**
 * ------------------------------------------------------------------
 * File: auth.messages.js
 * Module: Src Shared Modules Auth Messages
 *
 * Purpose:
 * Backend utility/module providing helper functions for auth.messages.
 *
 * Used By:
 * Server Entry / Direct Invocation
 * ------------------------------------------------------------------
 */

/**
 * Auth Module - User-Friendly Error Messages
 * 
 * This file contains all error messages for the Auth module.
 * Messages are designed to be easily understood by end users.
 */

/**
 * Authentication error and validation messages.
 * These are user-facing UI strings only - not credentials or secrets.
 */
module.exports = {
  // Signup Errors
  EMAIL_REQUIRED: 'Please enter your email address to create an account',
  EMAIL_INVALID: 'Please enter a valid email address (e.g., user@domain.com)',
  PASSWORD_REQUIRED: 'Please create a secure password for your account',
  PASSWORD_MIN_LENGTH: 'Your password must be at least 10 characters long',
  PASSWORD_MUST_CONTAIN_LETTER: 'Your password must include at least one letter (A-Z or a-z)',
  PASSWORD_MUST_CONTAIN_NUMBER: 'Your password must include at least one number (0-9)',
  PASSWORD_MUST_CONTAIN_SPECIAL: 'Your password must include at least one special character (e.g., !@#$%^&*)',
  FIRST_NAME_REQUIRED: 'Please enter your first name',
  FIRST_NAME_MIN_LENGTH: 'First name must be at least 1 character long',
  LAST_NAME_REQUIRED: 'Please enter your last name',
  LAST_NAME_MIN_LENGTH: 'Last name must be at least 1 character long',

  // Login Errors
  LOGIN_EMAIL_REQUIRED: 'Please enter your email address to sign in',
  LOGIN_PASSWORD_REQUIRED: 'Please enter your password to sign in',

  // Forgot Password Errors
  FORGOT_PASSWORD_EMAIL_REQUIRED: 'Please enter your email address to reset your password',

  // OTP Errors
  OTP_REQUIRED: 'Please enter the verification code sent to your email',
  OTP_EMAIL_REQUIRED: 'Email address is required to verify the code',
  NEW_PASSWORD_REQUIRED: 'Please enter your new password',
  CONFIRM_PASSWORD_REQUIRED: 'Please confirm your new password',

  // Reset Password Errors
  CURRENT_PASSWORD_REQUIRED: 'Please enter your current password',
  RESET_NEW_PASSWORD_REQUIRED: 'Please enter your new password',
  RESET_CONFIRM_PASSWORD_REQUIRED: 'Please confirm your new password',

  // Account Lock/Unlock Errors
  USER_ID_REQUIRED: 'User ID is required to perform this action',

  // Refresh Token Errors
  REFRESH_TOKEN_REQUIRED: 'Session token is required to refresh your login',

  // MFA Errors
  MFA_EMAIL_REQUIRED: 'Email address is required for two-factor authentication',
  MFA_ACTION_REQUIRED: 'Action type is required (login or signup)',
  MFA_ACTION_INVALID: 'Action must be either login or signup',
  MFA_OTP_REQUIRED: 'Please enter the verification code from your authenticator app',

  // Role Errors
  ROLE_NAME_REQUIRED: 'Please enter a name for this role',
  ROLE_NAME_MIN_LENGTH: 'Role name must be at least 1 character long',
  ROLE_FUNCTIONS_REQUIRED: 'Please select at least one permission for this role',
  ROLE_FUNCTION_ID_INVALID: 'The permission ID format is invalid',
  ROLE_ID_REQUIRED: 'Role ID is required to complete this action',
  ROLE_ID_INVALID: 'The role ID format is invalid',

  // Function Errors
  FUNCTION_NAME_REQUIRED: 'Please enter a name for this permission',
  FUNCTION_NAME_MIN_LENGTH: 'Permission name must be at least 1 character long',
  FUNCTION_ID_REQUIRED: 'Permission ID is required to complete this action',
  FUNCTION_ID_INVALID: 'The permission ID format is invalid',

  // General Errors
  INVALID_CREDENTIALS: 'The email or password you entered is incorrect',
  ACCOUNT_LOCKED: 'Your account has been locked. Please contact support for assistance',
  UNAUTHORIZED: 'You do not have permission to perform this action',
};
