const mongoose = require('mongoose');
const path = require('path');
const Group = require('./models/group.model');
const Message = require('./models/message.model');
require('dotenv').config({ path: './.env' });

async function checkData() {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const groups = await Group.find({
    $or: [
      { groupId: '120972082475028@lid' },
      { phoneJid: '919358360861@s.whatsapp.net' },
      { groupId: '919358360861@s.whatsapp.net' }
    ]
  });

  groups.forEach(g => {
    console.log(`Group: id=${g.groupId}, phoneJid=${g.phoneJid}, name=${g.name}`);
  });

  const messageCountLid = await Message.countDocuments({ groupId: '120972082475028@lid' });
  const messageCountPhone = await Message.countDocuments({ groupId: '919358360861@s.whatsapp.net' });

  console.log(`Messages for LID: ${messageCountLid}`);
  console.log(`Messages for Phone: ${messageCountPhone}`);

  await mongoose.disconnect();
}

checkData().catch(console.error);
