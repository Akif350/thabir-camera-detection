const mongoose = require('mongoose');

const cameraSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  rtspUrl: {
    type: String,
    required: true,
    unique: true
  },
  workspaceId: {
    type: String,
    required: true
  },
  streamName: {
    type: String,
    required: true,
    unique: true
  },
  publicUrl: {
    type: String,
    required: true
  },
  iceCastUrl: {
    type: String,
    default: ''
  },
  isIceCastUrl: {
    type: Boolean,
    default: true
  },
  manufacturer: {
    type: String,
    default: ''
  },
  region: {
    type: String,
    default: ''
  },
  country: {
    type: String,
    default: ''
  },
  postalCode: {
    type: String,
    default: ''
  },
  ipAddress: {
    type: String,
    default: ''
  },
  nvrUsername: {
    type: String,
    default: ''
  },
  nvrPassword: {
    type: String,
    default: ''
  },
  channelSupported: {
    type: Number,
    default: 4
  },
  active: {
    type: Boolean,
    default: true
  },
  streaming: {
    type: Boolean,
    default: false
  },
  processId: {
    type: Number,
    default: null
  },
  lastChecked: {
    type: Date,
    default: Date.now
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt field before saving
cameraSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model('Camera', cameraSchema);

