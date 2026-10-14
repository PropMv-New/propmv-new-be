/**
 * DocuSeal integration config.
 * Env vars (set in .env.local / .env.production):
 *   DOCUSEAL_API_KEY, DOCUSEAL_USER_EMAIL, DOCUSEAL_API_URL (optional)
 *   DOCUSEAL_DEFAULT_SIGNER_EMAIL, DOCUSEAL_DEFAULT_SIGNING_SRC (optional)
 *   DOCUSEAL_WEBHOOK_SECRET (optional - shared secret for /api/webhooks/docuseal)
 */
function trim(value) {
  return String(value || '').trim();
}

function getDocusealConfig() {
  const apiKey = trim(process.env.DOCUSEAL_API_KEY);
  const userEmail = trim(process.env.DOCUSEAL_USER_EMAIL);
  const apiUrl = trim(process.env.DOCUSEAL_API_URL) || 'https://api.docuseal.com';
  const defaultSignerEmail = trim(process.env.DOCUSEAL_DEFAULT_SIGNER_EMAIL) || userEmail;
  const defaultSigningSrc =
    trim(process.env.DOCUSEAL_DEFAULT_SIGNING_SRC) || 'https://docuseal.com/d/LEVGR9rhZYf86M';
  const webhookSecret = trim(process.env.DOCUSEAL_WEBHOOK_SECRET);

  const configured = Boolean(apiKey && userEmail && !apiKey.includes('PASTE_YOUR'));
  const modeHint = userEmail.includes('+test') ? 'test' : 'production';

  return {
    apiKey,
    userEmail,
    apiUrl,
    defaultSignerEmail,
    defaultSigningSrc,
    webhookSecret,
    configured,
    modeHint,
  };
}

module.exports = { getDocusealConfig };
