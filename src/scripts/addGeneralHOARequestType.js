/**
 * Idempotently add HOA category + subcategory "General".
 * Run: node src/scripts/addGeneralHOARequestType.js
 *
 * Environment:
 *   DB_URL or MONGO_URI  (required)
 *   DB_NAME              (optional, default PropMv)
 */

const mongoose = require('mongoose');

const MasterData = require('../shared/modules/master/model/masterData.model');

const KEY = 'HOA_Primary_RequestTypes';
const GENERAL = 'General';
const GENERAL_ENTRY = { primary: GENERAL, subTypes: [GENERAL] };

function hasGeneralSubType(subTypes) {
  if (!Array.isArray(subTypes)) return false;
  return subTypes.some((item) => {
    if (typeof item === 'string') return item === GENERAL;
    return item?.name === GENERAL;
  });
}

function ensureGeneralEntry(data) {
  const next = Array.isArray(data) ? [...data] : [];
  const idx = next.findIndex((item) => item?.primary === GENERAL);

  if (idx === -1) {
    next.push(GENERAL_ENTRY);
    return { data: next, changed: true, action: 'added' };
  }

  if (hasGeneralSubType(next[idx].subTypes)) {
    return { data: next, changed: false, action: 'already-present' };
  }

  const current = next[idx];
  next[idx] = {
    ...current,
    subTypes: [...(current.subTypes || []), GENERAL],
  };
  return { data: next, changed: true, action: 'updated-subtypes' };
}

async function addGeneralHOARequestType() {
  const uri = process.env.DB_URL || process.env.MONGO_URI;
  if (!uri) {
    throw new Error('DB_URL (or MONGO_URI) is not set');
  }

  const dbName = process.env.DB_NAME || 'PropMv';
  await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 15000),
  });
  console.log(`Connected (${dbName})`);

  const existing = await MasterData.findOne({ key: KEY });
  if (!existing) {
    await MasterData.create({
      type: 'HOA_RequestType',
      key: KEY,
      data: [GENERAL_ENTRY],
    });
    console.log(`Created ${KEY} with General`);
  } else {
    const { data, changed, action } = ensureGeneralEntry(existing.data);
    if (changed) {
      existing.data = data;
      await existing.save();
    }
    console.log(`${KEY}: ${action}`);
  }

  const saved = await MasterData.findOne({ key: KEY }).lean();
  const primaries = (saved?.data || []).map((item) => ({
    primary: item.primary,
    subTypes: item.subTypes,
  }));
  console.log(JSON.stringify(primaries, null, 2));

  await mongoose.disconnect();
}

if (require.main === module) {
  addGeneralHOARequestType()
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('Failed to add General request type:', err.message);
      try { await mongoose.disconnect(); } catch {}
      process.exit(1);
    });
}

module.exports = { addGeneralHOARequestType, ensureGeneralEntry, GENERAL_ENTRY };
