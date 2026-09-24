'use strict';

const mongoose = require('mongoose');

const ConfirmationCampaignSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: [true, 'Tenant ID is required'],
    trim: true,
    lowercase: true,
    index: true,
  },

  campaignTitle: {
    type: String,
    required: [true, 'Campaign title is required'],
    trim: true,
  },

  companyCode: {
    type: String,
    required: [true, 'Company code is required'],
    trim: true,
  },

  companyName: {
    type: String,
    required: [true, 'Company name is required'],
    trim: true,
  },

  unitName: {
    type: String,
    trim: true,
    default: '',
  },

  keyCutOffDate: {
    type: Date,
    required: [true, 'Cut-off date (KeyDate) is required'],
  },

  fiscalYear: {
    type: String,
    trim: true,
    default: '',
  },

  responseDeadlineDays: {
    type: Number,
    default: 10,
  },

  auditorGroupEmail: {
    type: String,
    required: [true, 'Auditor group email is required'],
    trim: true,
    lowercase: true,
  },

  clientApEmail: {
    type: String,
    required: [true, 'Client AP email is required'],
    trim: true,
    lowercase: true,
  },

  initiatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  totalVendors: {
    type: Number,
    default: 0,
  },

  confirmedCount: {
    type: Number,
    default: 0,
  },

  disputedCount: {
    type: Number,
    default: 0,
  },

  pendingCount: {
    type: Number,
    default: 0,
  },

  reconciledCount: {
    type: Number,
    default: 0,
  },

  status: {
    type: String,
    enum: ['DRAFT', 'DISPATCHED', 'COMPLETED', 'CLOSED'],
    default: 'DISPATCHED',
    index: true,
  },
}, {
  timestamps: true,
});

ConfirmationCampaignSchema.index({ tenantId: 1, createdAt: -1 });

module.exports = mongoose.model('ConfirmationCampaign', ConfirmationCampaignSchema);
