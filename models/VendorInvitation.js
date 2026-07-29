const mongoose = require('mongoose');

const VendorInvitationSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: [true, 'Tenant ID is required'],
    trim: true,
    lowercase: true,
    index: true,
  },
  sapVendorNumber: {
    type: String,
    required: [true, 'SAP Vendor Number is required'],
    trim: true,
    index: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    trim: true,
    lowercase: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
  },
  vendorName: {
    type: String,
    required: [true, 'Vendor name is required'],
    trim: true,
  },
  vendorGroup: {
    type: String,
    required: [true, 'Vendor Group is required'],
    trim: true,
  },
  companyCode: {
    type: String,
    trim: true,
  },
  token: {
    type: String,
    required: [true, 'Token is required'],
    unique: true,
    index: true,
  },
  expiresAt: {
    type: Date,
    required: [true, 'Expiration date is required'],
  },
  status: {
    type: String,
    enum: ['PENDING', 'REGISTERED', 'EXPIRED'],
    default: 'PENDING',
  }
}, {
  timestamps: true,
});

module.exports = mongoose.model('VendorInvitation', VendorInvitationSchema);
