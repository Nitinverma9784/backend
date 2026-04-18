const mongoose = require('mongoose');
const path = require('path');
const Group = require('./models/group.model');
require('dotenv').config({ path: './.env' });

async function listAllLids() {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const groups = await Group.find({
    groupId: /@lid$/
  });

  console.log(`LID groups found: ${groups.length}`);
  groups.forEach(g => {
    console.log(`Group: id=${g.groupId}, phoneJid=${g.phoneJid}, name=${g.name}`);
  });

  await mongoose.disconnect();
}

listAllLids().catch(console.error);
