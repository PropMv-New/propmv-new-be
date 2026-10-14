#!/usr/bin/env node
'use strict';

/**
 * Backfill Property.billingTimezone from address zip/state.
 * Covers landlord and HOA property collections.
 * Usage: node propmv/scripts/backfill-property-billing-timezone.js [--dry-run]
 */

require('../src/config/loadEnv');
const mongoose = require('mongoose');
const LandlordProperty = require('../src/portals/landlord/modules/property/model/property.model');
const HoaProperty = require('../src/portals/hoa-board/modules/property/model/property.model');
const { backfillBillingTimezoneFromAddress } = require('../src/common/helpers/resolvePropertyBillingTimezone');
const { toObjectId } = require('../src/common/db/mongooseHelpers');

const DRY_RUN = process.argv.includes('--dry-run');

async function backfillModel(Model, label) {
  const cursor = Model.find({ isDeleted: { $ne: true } })
    .select('_id address billingTimezone billingTimezoneSource')
    .cursor();

  let scanned = 0;
  let updated = 0;

  for await (const property of cursor) {
    scanned += 1;
    if (property.billingTimezone && property.billingTimezoneSource === 'manual') {
      continue;
    }

    const next = backfillBillingTimezoneFromAddress(property);
    const changed =
      property.billingTimezone !== next.billingTimezone
      || property.billingTimezoneSource !== next.billingTimezoneSource;

    if (!changed) continue;

    const propertyId = toObjectId(property._id);
    if (!propertyId) {
      console.warn(`[backfill-billing-timezone][${label}] skipped invalid property id: ${property._id}`);
      continue;
    }

    updated += 1;
    if (DRY_RUN) {
      console.log(`[dry-run][${label}] ${propertyId} -> ${next.billingTimezone} (${next.billingTimezoneSource})`);
      continue;
    }

    await Model.updateOne(
      { _id: propertyId },
      {
        $set: {
          billingTimezone: String(next.billingTimezone || ''),
          billingTimezoneSource: String(next.billingTimezoneSource || ''),
        },
      }
    );
  }

  console.log(`[backfill-billing-timezone][${label}] scanned=${scanned} updated=${updated}`);
  return { scanned, updated };
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`[backfill-billing-timezone] Connected (${DRY_RUN ? 'dry-run' : 'live'})`);

  await backfillModel(LandlordProperty, 'landlord');
  await backfillModel(HoaProperty, 'hoa');

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('[backfill-billing-timezone] Failed:', error?.message || error);
  process.exit(1);
});
