/**
 * Outbound email origin - distinguishes Email-tab (user) vs automated (system) mail.
 */
const EMAIL_ORIGIN = {
  USER: 'user',
  SYSTEM: 'system',
};

const ALL_EMAIL_ORIGINS = Object.values(EMAIL_ORIGIN);

module.exports = {
  EMAIL_ORIGIN,
  ALL_EMAIL_ORIGINS,
};
