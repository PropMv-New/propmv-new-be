const { DateUtil } = require('../../../../../common/date');
const {
  getDateKeyInTimeZone,
  parseDateOnlyToNoonUtc,
  parseAppYmd,
  shiftAppYmdDays,
} = require('../../../../../common/helpers/hoaBillingDates');

function toStoredLeaseDate(value) {
  if (value == null || value === '') return null;
  const key = getDateKeyInTimeZone(value);
  return key ? parseDateOnlyToNoonUtc(key) : DateUtil.toUTC(value);
}

function addYearsToStoredDate(value, years) {
  const key = getDateKeyInTimeZone(value);
  const p = parseAppYmd(key);
  if (!p) return DateUtil.toUTC(value);
  return parseDateOnlyToNoonUtc(
    `${p.y + years}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
  ) || DateUtil.toUTC(value);
}

function assertSemiAnnualFeeDatesInTenure(additionalFees, leaseStart, leaseEnd) {
  if (!additionalFees || !Array.isArray(additionalFees) || !leaseStart) return;
  const effectiveEnd = leaseEnd || addYearsToStoredDate(leaseStart, 1);
  const startP = parseAppYmd(getDateKeyInTimeZone(leaseStart));
  const endP = parseAppYmd(getDateKeyInTimeZone(effectiveEnd));
  if (!startP || !endP) return;

  for (const fee of additionalFees) {
    if (fee.frequency !== 'semi-annually' || !Array.isArray(fee.semiAnnualDates)) continue;
    for (const dateConfig of fee.semiAnnualDates) {
      let dateFound = false;
      for (let year = startP.y; year <= endP.y; year += 1) {
        const checkDate = parseDateOnlyToNoonUtc(
          `${year}-${String(dateConfig.month).padStart(2, '0')}-${String(dateConfig.day).padStart(2, '0')}`
        );
        if (
          checkDate
          && checkDate.getTime() >= leaseStart.getTime()
          && checkDate.getTime() <= effectiveEnd.getTime()
        ) {
          dateFound = true;
          break;
        }
      }
      if (!dateFound) {
        const startLabel = getDateKeyInTimeZone(leaseStart) || '';
        const endLabel = getDateKeyInTimeZone(effectiveEnd) || '';
        throw Object.assign(
          new Error(
            `Additional fee semi-annual date (${dateConfig.month}/${dateConfig.day}) does not fall within lease tenure (${startLabel} to ${endLabel}). Please select dates within the lease period.`
          ),
          { status: 400 }
        );
      }
    }
  }
}

function computeRenewalDates(lease) {
  const startKey = getDateKeyInTimeZone(lease.start_date);
  const endKey = getDateKeyInTimeZone(lease.end_date);
  const startDate = parseDateOnlyToNoonUtc(startKey);
  const endDate = parseDateOnlyToNoonUtc(endKey);
  if (!startDate || !endDate || !endKey) {
    throw new Error('Lease start and end dates are required for renewal');
  }
  const duration = DateUtil.diffDays(startDate, endDate);
  const newStartKey = shiftAppYmdDays(endKey, 1);
  const newEndKey = shiftAppYmdDays(newStartKey, duration);
  return {
    newStartDate: parseDateOnlyToNoonUtc(newStartKey),
    newEndDate: parseDateOnlyToNoonUtc(newEndKey),
    previousEndDate: endDate,
  };
}

module.exports = {
  toStoredLeaseDate,
  addYearsToStoredDate,
  assertSemiAnnualFeeDatesInTenure,
  computeRenewalDates,
};
