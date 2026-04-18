const mongoose = require('mongoose');
const Group = require('./models/group.model');
const fs = require('fs');
require('dotenv').config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-crm');
  const groups = await Group.find().lean();
  let log = 'All Groups/Chats in DB:\n';
  groups.forEach(g => {
    log += `ID: ${g.groupId}, Name: ${g.name}, Messages recorded: ${g.lastMessage ? 'Yes' : 'No'}\n`;
  });
  
  fs.writeFileSync('all_groups.txt', log, 'utf8');
  console.log('Check complete. See all_groups.txt');
  process.exit(0);
}
check();
