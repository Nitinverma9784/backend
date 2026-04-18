const mongoose = require('mongoose');
const path = require('path');
const Group = require('./models/group.model');
const Message = require('./models/message.model');
require('dotenv').config({ path: './.env' });

async function fixMapping() {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const lidJid = '120972082475028@lid';
  const phoneJid = '919358360861@s.whatsapp.net';

  // 1. Update Group mapping
  const group = await Group.findOneAndUpdate(
    { groupId: lidJid },
    { $set: { phoneJid: phoneJid } },
    { upsert: true, new: true }
  );
  console.log('Updated Group mapping:', group.groupId, '->', group.phoneJid);

  // 2. Migrate existing messages from phone JID to LID
  const result = await Message.updateMany(
    { groupId: phoneJid },
    { $set: { groupId: lidJid } }
  );
  console.log(`Migrated ${result.modifiedCount} messages from ${phoneJid} to ${lidJid}`);

  // 3. Mark the LID as being updated
  await Message.updateMany(
    { groupId: lidJid },
    { $set: { _sourcePhoneJid: phoneJid } } // metadata
  );

  await mongoose.disconnect();
}

fixMapping().catch(console.error);
