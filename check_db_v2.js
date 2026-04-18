const mongoose = require('mongoose');
const Message = require('./models/message.model');
const fs = require('fs');
require('dotenv').config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-crm');
  const count = await Message.countDocuments();
  let log = 'Total messages in DB: ' + count + '\n';
  
  const allGroups = await Message.aggregate([
    { $group: { _id: "$groupId", count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
  
  log += 'Groups summary:\n';
  allGroups.forEach(g => {
    log += `Group: ${g._id}, Messages: ${g.count}\n`;
  });
  
  fs.writeFileSync('db_summary.txt', log, 'utf8');
  console.log('Check complete. See db_summary.txt');
  process.exit(0);
}
check();
