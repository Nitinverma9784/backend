const mongoose = require('mongoose');

const authSessionSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  data: {
    type: String, // Stringified BufferJSON
    required: true,
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('AuthSession', authSessionSchema);
