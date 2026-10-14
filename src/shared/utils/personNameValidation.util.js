const Joi = require('joi');

const PERSON_NAME_MAX_LENGTH = 100;
const PERSON_NAME_LETTER = /\p{L}|\p{M}/u;
const PERSON_NAME_BASE_CHAR = /[\p{L}\p{M}0-9 .'-]/u;
const PERSON_NAME_INVALID_MESSAGE =
  'contains invalid characters. Names must start with a letter. Use letters, numbers, spaces, hyphens, apostrophes, or periods. Ampersands are allowed after a letter (e.g. Alan & Susan).';

function letterBeforeAmpersand(value, ampIndex) {
  let j = ampIndex - 1;
  while (j >= 0 && value[j] === ' ') j -= 1;
  return j >= 0 && PERSON_NAME_LETTER.test(value[j]);
}

function isValidPersonName(value, { max = PERSON_NAME_MAX_LENGTH, allowEmpty = false } = {}) {
  if (value == null || String(value).trim() === '') return allowEmpty;
  const v = String(value).trim();
  if (v.length > max) return false;
  if (!PERSON_NAME_LETTER.test(v[0])) return false;
  if (v.startsWith('&') || v.endsWith('&')) return false;

  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '&') {
      if (!letterBeforeAmpersand(v, i)) return false;
      continue;
    }
    if (!PERSON_NAME_BASE_CHAR.test(ch)) return false;
  }
  return true;
}

function personNameFieldJoi(label, { required = true, max = PERSON_NAME_MAX_LENGTH } = {}) {
  let schema = Joi.string().trim().max(max);
  if (required) {
    schema = schema.min(1).required();
  } else {
    schema = schema.optional().allow('');
  }

  return schema.custom((value, helpers) => {
    if ((value == null || value === '') && !required) return value;
    if (!isValidPersonName(value, { max, allowEmpty: !required })) {
      return helpers.error('string.pattern.base');
    }
    return value;
  }).messages({
    'string.empty': `${label} cannot be empty`,
    'string.min': `${label} must be at least 1 character`,
    'string.max': `${label} cannot exceed ${max} characters`,
    'string.pattern.base': `${label} ${PERSON_NAME_INVALID_MESSAGE}`,
    'any.required': `${label} is required`,
  });
}

function optionalPersonNameFieldJoi(label = 'Name', { max = PERSON_NAME_MAX_LENGTH } = {}) {
  return personNameFieldJoi(label, { required: false, max });
}

module.exports = {
  PERSON_NAME_MAX_LENGTH,
  PERSON_NAME_INVALID_MESSAGE,
  isValidPersonName,
  personNameFieldJoi,
  optionalPersonNameFieldJoi,
};
