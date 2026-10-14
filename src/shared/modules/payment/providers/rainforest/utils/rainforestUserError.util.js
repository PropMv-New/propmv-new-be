'use strict';

function toUserFriendlyRainforestMessage(status, detail) {
  const message = String(detail || '').trim();
  const lower = message.toLowerCase();

  if (lower.includes('merchant name') && lower.includes('unique')) {
    return 'This business name is already registered in Rainforest. Please enter a different business name and try again.';
  }
  if (lower.includes('invalid merchant name')) {
    return 'Please enter a valid business name using letters, numbers, and common punctuation.';
  }
  if (status === 401 || lower.includes('authentication')) {
    return 'Rainforest authentication failed. Please contact support.';
  }
  if (status === 403) {
    return 'You do not have permission to perform this Rainforest action.';
  }
  if (status === 404) {
    return 'The requested Rainforest record could not be found.';
  }
  if (status === 409) {
    return 'This Rainforest business account already exists.';
  }
  if (status === 422 || status === 400) {
    if (message && !message.startsWith('Invalid Rainforest')) return message;
    return 'Some business details are invalid. Please review the form and try again.';
  }
  if (status === 429) {
    return 'Rainforest is busy right now. Please wait a moment and try again.';
  }
  if (lower.includes('not configured') || lower.includes('platform id')) {
    return message || 'Rainforest platform is not configured. Contact support.';
  }
  if (lower.includes('billable merchant is required') || lower.includes('no active rainforest merchant')) {
    return message || 'An active Rainforest business merchant is required before owners or tenants can save cards or bank accounts.';
  }
  if (status >= 500) {
    return 'Rainforest is temporarily unavailable. Please try again in a few minutes.';
  }

  return message || 'Something went wrong while connecting to Rainforest. Please try again.';
}

module.exports = {
  toUserFriendlyRainforestMessage,
};
