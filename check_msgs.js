const mongoose = require('mongoose');
const Message = require('./models/message.model');
require('dotenv').config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/whatsapp-crm');
  const target = '918890468443@s.whatsapp.net';
  const messages = await Message.find({ groupId: target }).sort({ timestamp: -1 }).lean();
  console.log(`Messages for ${target}:`, messages.length);
  messages.slice(0, 5).forEach(m => {
    console.log(`- ${m.timestamp} : ${m.text.substring(0, 30)}... [ID: ${m.messageId}]`);
  });
  process.exit(0);
}
check();
