/**
 * Build SMTP To/Cc/Bcc so one message goes to everyone, but recipients
 * cannot see each other's addresses (multi-recipient privacy via BCC).
 *
 * Stored Email.to can keep the full recipient list for the Sent UI;
 * only the outbound SMTP envelope uses these rewritten fields.
 */

function splitEmailAddresses(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => splitEmailAddresses(item))
      .filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function uniqueEmails(addresses) {
  const out = [];
  const seen = new Set();
  for (const raw of addresses) {
    const email = String(raw || '').trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * @param {{ to?: string|string[], cc?: string|string[]|null, bcc?: string|string[]|null, envelopeTo?: string|null }} input
 * @returns {{ to: string, cc: string|null, bcc: string|null, recipientCount: number }}
 */
function buildPrivateRecipientPayload({ to, cc = null, bcc = null, envelopeTo = null } = {}) {
  const allRecipients = uniqueEmails([
    ...splitEmailAddresses(to),
    ...splitEmailAddresses(cc),
    ...splitEmailAddresses(bcc),
  ]);

  if (allRecipients.length === 0) {
    return { to: '', cc: null, bcc: null, recipientCount: 0 };
  }

  if (allRecipients.length === 1) {
    return {
      to: allRecipients[0],
      cc: null,
      bcc: null,
      recipientCount: 1,
    };
  }

  const envelope = String(envelopeTo || '').trim() || allRecipients[0];
  const envelopeKey = envelope.toLowerCase();
  // Prefer putting every selected recipient in BCC. To is the sender envelope
  // so no other recipient address appears in a visible header.
  const bccList = allRecipients.filter((addr) => addr.toLowerCase() !== envelopeKey);
  const finalBcc = bccList.length > 0 ? bccList : allRecipients.filter((addr) => addr.toLowerCase() !== envelopeKey);

  // If envelope equals first recipient (fallback when no sender email), BCC the rest only.
  // If envelope is the sender (not in recipient list), BCC everyone.
  return {
    to: envelope,
    cc: null,
    bcc: (finalBcc.length ? finalBcc : allRecipients.slice(1)).join(', '),
    recipientCount: allRecipients.length,
  };
}

module.exports = {
  splitEmailAddresses,
  uniqueEmails,
  buildPrivateRecipientPayload,
};
