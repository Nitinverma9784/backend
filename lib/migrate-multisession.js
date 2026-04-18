const mongoose = require('mongoose');
const WaSession = require('../models/wa-session.model');
const Message = require('../models/message.model');
const Group = require('../models/group.model');
const AuthSession = require('../models/auth-session.model');
const Setting = require('../models/setting.model');

/**
 * Old schema used unique index on `id`. New schema uses sessionId + storageKey.
 * If `id_1` is left in MongoDB, every upsert without `id` collides as { id: null } → Baileys cannot save keys.
 */
async function fixAuthSessionIndexes() {
  const coll = mongoose.connection.collection('authsessions');
  let indexes = [];
  try {
    indexes = await coll.indexes();
  } catch (err) {
    console.warn('[Migrate] authsessions indexes:', err.message);
    return;
  }

  for (const idx of indexes) {
    const key = idx.key || {};
    const names = Object.keys(key);
    if (names.length === 1 && names[0] === 'id') {
      try {
        await coll.dropIndex(idx.name);
        console.log('[Migrate] Dropped legacy authsessions index:', idx.name);
      } catch (err) {
        console.warn('[Migrate] Could not drop index', idx.name, err.message);
      }
    }
  }
}

async function migrateMultiSession(defaultTenantId) {
  await fixAuthSessionIndexes();

  let primary = await WaSession.findOne().sort({ createdAt: 1 });

  if (!primary) {
    primary = await WaSession.create({
      tenantId: defaultTenantId,
      label: 'Primary',
      sortOrder: 0,
    });
    console.log('[Migrate] Created default WaSession:', primary._id);
  }

  const sid = primary._id;
  const rawAuth = mongoose.connection.collection('authsessions');

  const legacyAuth = await rawAuth
    .find({
      $or: [{ sessionId: { $exists: false } }, { sessionId: null }],
      storageKey: { $exists: false },
    })
    .toArray();

  for (const d of legacyAuth) {
    const storageKey = d.id != null ? String(d.id) : d.storageKey;
    if (!storageKey) continue;
    await rawAuth.updateOne(
      { _id: d._id },
      {
        $set: { sessionId: sid, storageKey },
        $unset: { id: '' },
      }
    );
  }
  if (legacyAuth.length) console.log('[Migrate] Normalized', legacyAuth.length, 'legacy auth rows');

  try {
    const r = await rawAuth.updateMany({ id: { $exists: true } }, { $unset: { id: '' } });
    if (r.modifiedCount) console.log('[Migrate] Stripped legacy `id` from', r.modifiedCount, 'auth rows');
  } catch (err) {
    console.warn('[Migrate] Strip legacy id:', err.message);
  }

  try {
    await AuthSession.syncIndexes();
  } catch (err) {
    console.warn('[Migrate] AuthSession.syncIndexes:', err.message);
  }

  const msgRes = await Message.updateMany(
    { $or: [{ sessionId: { $exists: false } }, { sessionId: null }] },
    { $set: { sessionId: sid } }
  );
  if (msgRes.modifiedCount) console.log('[Migrate] Messages tagged:', msgRes.modifiedCount);

  const grpRes = await Group.updateMany(
    { $or: [{ sessionId: { $exists: false } }, { sessionId: null }] },
    { $set: { sessionId: sid } }
  );
  if (grpRes.modifiedCount) console.log('[Migrate] Groups tagged:', grpRes.modifiedCount);

  const rawSettings = mongoose.connection.collection('settings');
  const orphans = await rawSettings
    .find({
      $or: [{ waSessionId: { $exists: false } }, { waSessionId: null }],
    })
    .toArray();

  if (orphans.length > 1) {
    const [, ...rest] = orphans;
    for (const doc of rest) {
      await rawSettings.deleteOne({ _id: doc._id });
    }
    console.log('[Migrate] Deduplicated settings documents:', orphans.length - 1);
  }

  await rawSettings.updateMany(
    { $or: [{ waSessionId: { $exists: false } }, { waSessionId: null }] },
    { $set: { waSessionId: sid }, $unset: { userId: '' } }
  );

  const settingsCount = await Setting.countDocuments({ waSessionId: sid });
  if (settingsCount === 0) {
    await Setting.create({
      waSessionId: sid,
      backupEnabled: false,
      perGroupBackup: {},
    });
    console.log('[Migrate] Created settings for Primary session');
  }

  return primary;
}

module.exports = { migrateMultiSession };
