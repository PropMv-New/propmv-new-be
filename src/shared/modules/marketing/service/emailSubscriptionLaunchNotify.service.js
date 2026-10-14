const { sendEmail } = require('../../../../common/helpers/emailHelper');

const LAUNCH_ANNOUNCEMENT_SUBJECT =
  process.env.EMAIL_SUBJECT_COMING_SOON_LAUNCH || 'PropMv is live - your early access is here!';

function resolveSiteUrl() {
  const raw = process.env.FRONTEND_URL || process.env.APP_URL || '';
  return String(raw).trim().replace(/\/+$/, '');
}

function resolveSignupUrl() {
  const siteUrl = resolveSiteUrl();
  return siteUrl ? `${siteUrl}/signup` : '';
}

async function sendLaunchAnnouncementEmail(email) {
  return sendEmail(
    'coming-soon-launch',
    email,
    {
      userName: 'there',
      siteUrl: resolveSiteUrl(),
      signupUrl: resolveSignupUrl(),
    },
    {
      subject: LAUNCH_ANNOUNCEMENT_SUBJECT,
      preheaderText: 'PropMv is live. Create your account and explore the platform today.',
    }
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  sendLaunchAnnouncementEmail,
  sleep,
  LAUNCH_ANNOUNCEMENT_SUBJECT,
};
