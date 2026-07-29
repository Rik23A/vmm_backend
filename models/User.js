const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  fullName: {
    type: String,
    required: [true, 'Full name is required'],
    trim: true,
    maxlength: [100, 'Full name cannot exceed 100 characters'],
  },

  email: {
    type: String,
    required: [true, 'Email is required'],
    trim: true,
    lowercase: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
  },

  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false, // Never returned in queries by default
  },

  role: {
    type: String,
    required: [true, 'Role is required'],
    default: 'REQUESTOR',
  },

  // Multi-tenancy: every user belongs to exactly one tenant/company
  tenantId: {
    type: String,
    required: [true, 'Tenant ID is required'],
    trim: true,
    lowercase: true,
    index: true,
  },

  isActive: {
    type: Boolean,
    default: true,
  },

  isFirstLogin: {
    type: Boolean,
    default: true,
  },

  plants: {
    type: [String],
    default: [],
  },

  // Track last login for security audit
  lastLogin: {
    type: Date,
    default: null,
  },

  // Password reset
  resetPasswordToken: { type: String, select: false },
  resetPasswordExpires: { type: Date, select: false },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  sapVendorNumber: {
    type: String,
    default: null,
    index: true,
  },
}, {
  timestamps: true,
});

// ── Compound index: email must be unique per tenant (not globally)
UserSchema.index({ email: 1, tenantId: 1 }, { unique: true });

// ── Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ── Compare password method
UserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// ── Never return password in JSON
UserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.resetPasswordToken;
  delete obj.resetPasswordExpires;
  return obj;
};

module.exports = mongoose.model('User', UserSchema);
