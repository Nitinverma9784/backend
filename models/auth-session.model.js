const mongoose = require('mongoose');

const authSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'WaSession',
      required: true,
      index: true,
    },
    /** Baileys storage key e.g. creds, app-state-sync-key-<id>, pre-key-… */
    storageKey: {
      type: String,
      required: true,
    },
    data: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

authSessionSchema.index({ sessionId: 1, storageKey: 1 }, { unique: true });

module.exports = mongoose.model('AuthSession', authSessionSchema);
