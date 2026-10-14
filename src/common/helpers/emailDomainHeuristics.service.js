/**
 * Free pre-send email heuristics: common domain typos + disposable domains.
 * Does not replace mailbox verification APIs; reduces obvious bad sends.
 *
 * Env:
 *   EMAIL_BLOCK_TYPO_DOMAINS       (default true)
 *   EMAIL_BLOCK_DISPOSABLE_DOMAINS (default true)
 */

const TYPO_DOMAIN_MAP = {
  // Gmail
  'gmial.com': 'gmail.com',
  'gmal.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gmail.con': 'gmail.com',
  'gmail.co': 'gmail.com',
  'gmail.cm': 'gmail.com',
  'gmail.om': 'gmail.com',
  'gmaill.com': 'gmail.com',
  'g-mail.com': 'gmail.com',
  // Hotmail / Outlook / Live
  'hotnail.com': 'hotmail.com',
  'hotmai.com': 'hotmail.com',
  'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'outllok.com': 'outlook.com',
  'outlook.con': 'outlook.com',
  'outlook.co': 'outlook.com',
  'live.con': 'live.com',
  // Yahoo
  'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com',
  'yahoo.con': 'yahoo.com',
  'yhoo.com': 'yahoo.com',
  // iCloud / Apple
  'iclod.com': 'icloud.com',
  'icloud.con': 'icloud.com',
  'me.con': 'me.com',
  // Proton
  'protonmai.com': 'protonmail.com',
  'protonmail.con': 'protonmail.com',
};

/** Compact disposable / throwaway domain set (lowercase). */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'sharklasers.com',
  'grr.la',
  'guerrillamail.info',
  'pokemail.net',
  'spam4.me',
  'tempmail.com',
  'temp-mail.org',
  'tempmailo.com',
  '10minutemail.com',
  '10minemail.com',
  'yopmail.com',
  'yopmail.fr',
  'trashmail.com',
  'trashmail.me',
  'discard.email',
  'discardmail.com',
  'mailnesia.com',
  'maildrop.cc',
  'getnada.com',
  'emailondeck.com',
  'fakeinbox.com',
  'throwawaymail.com',
  'mintemail.com',
  'moakt.com',
  'tempail.com',
  'mailcatch.com',
  'inboxkitten.com',
  'mailnull.com',
  'spamgourmet.com',
  'mytemp.email',
  'tmpmail.org',
  'tmpmail.net',
  'emailfake.com',
  'crazymailing.com',
]);

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function getTypoSuggestion(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return null;
  const suggested = TYPO_DOMAIN_MAP[d];
  if (!suggested) return null;
  return { from: d, to: suggested };
}

function isDisposableDomain(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return false;
  if (DISPOSABLE_DOMAINS.has(d)) return true;
  // Subdomains of known disposable providers
  for (const base of DISPOSABLE_DOMAINS) {
    if (d.endsWith(`.${base}`)) return true;
  }
  return false;
}

/**
 * @returns {{ ok: true } | { ok: false, code: string, message: string, suggestion?: string }}
 */
function evaluateDomainHeuristics(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at < 0) return { ok: true };
  const domain = normalized.slice(at + 1);
  const local = normalized.slice(0, at);

  if (envBool('EMAIL_BLOCK_TYPO_DOMAINS', true)) {
    const typo = getTypoSuggestion(domain);
    if (typo) {
      const suggestion = `${local}@${typo.to}`;
      return {
        ok: false,
        code: 'EMAIL_TYPO_DOMAIN',
        message: `This email domain looks like a typo. Did you mean ${suggestion}?`,
        suggestion,
      };
    }
  }

  if (envBool('EMAIL_BLOCK_DISPOSABLE_DOMAINS', true) && isDisposableDomain(domain)) {
    return {
      ok: false,
      code: 'EMAIL_DISPOSABLE_DOMAIN',
      message:
        'Temporary or disposable email addresses are not allowed. Please use a permanent email address.',
    };
  }

  return { ok: true };
}

module.exports = {
  TYPO_DOMAIN_MAP,
  DISPOSABLE_DOMAINS,
  getTypoSuggestion,
  isDisposableDomain,
  evaluateDomainHeuristics,
};
