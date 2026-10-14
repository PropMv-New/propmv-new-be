const logger = require('../../../../common/logger');
const { sendEmail } = require('../../../../common/helpers/emailHelper');

const SUBSCRIPTION_CONFIRMATION_SUBJECT =
  process.env.EMAIL_SUBJECT_COMING_SOON_SUBSCRIPTION ||
  "You're on the PropMv launch list!";

async function sendSubscriptionConfirmationEmail(email) {
  return sendEmail(
    'coming-soon-subscription',
    email,
    {
      userName: 'there',
    },
    {
      subject: SUBSCRIPTION_CONFIRMATION_SUBJECT,
      preheaderText:
        "Thanks for joining the PropMv launch list. We'll keep you updated as we get closer to go-live.",
    }
  );
}

function notifySubscriptionConfirmationInBackground(email) {
  sendSubscriptionConfirmationEmail(email).catch((err) =>
    logger.error('[Marketing] Subscription confirmation email failed:', err.message)
  );
}

module.exports = {
  sendSubscriptionConfirmationEmail,
  notifySubscriptionConfirmationInBackground,
};
