const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const SuperAdmin = require('../models/SuperAdmin');
const Tenant = require('../models/Tenant');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { requireSuperAdminLogin } = require('../middleware/auth');

// ── Helper: generate JWT for SuperAdmin ─────────────────────────────
const signSuperAdminToken = (admin) => jwt.sign(
  { userId: admin._id, role: 'SUPER_ADMIN' },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);

// ── POST /api/super-admin/login ─────────────────────────────────────
router.post('/login', [
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;

    const admin = await SuperAdmin.findOne({ email }).select('+password');
    if (!admin || !(await admin.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    if (!admin.isActive) {
      return res.status(403).json({ message: 'Your account has been deactivated.' });
    }

    admin.lastLogin = new Date();
    await admin.save({ validateBeforeSave: false });

    const token = signSuperAdminToken(admin);
    res.json({
      token,
      admin: admin.toJSON(),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/super-admin/me ─────────────────────────────────────────
router.get('/me', requireSuperAdminLogin, async (req, res) => {
  res.json({ admin: req.user });
});

// ── GET /api/super-admin/tenants ────────────────────────────────────
router.get('/tenants', requireSuperAdminLogin, async (req, res, next) => {
  try {
    const tenants = await Tenant.find({}).sort({ createdAt: -1 });
    res.json({ tenants });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/super-admin/tenants/:id ──────────────────────────────
router.patch('/tenants/:id', requireSuperAdminLogin, async (req, res, next) => {
  try {
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found.' });

    const { isActive, subscription, modules } = req.body;

    if (isActive !== undefined) {
      tenant.isActive = isActive;
    }
    if (subscription) {
      if (subscription.plan) tenant.subscription.plan = subscription.plan;
      if (subscription.status) tenant.subscription.status = subscription.status;
      if (subscription.trialEndsAt !== undefined) tenant.subscription.trialEndsAt = subscription.trialEndsAt;
      if (subscription.paidUntil !== undefined) tenant.subscription.paidUntil = subscription.paidUntil;
    }
    if (modules && typeof modules === 'object') {
      if (!tenant.modules) tenant.modules = {};
      if (modules.vendorMaster !== undefined) tenant.modules.vendorMaster = Boolean(modules.vendorMaster);
      if (modules.balanceConfirmation !== undefined) tenant.modules.balanceConfirmation = Boolean(modules.balanceConfirmation);
      if (modules.customerMaster !== undefined) tenant.modules.customerMaster = Boolean(modules.customerMaster);
      tenant.markModified('modules');
    }

    await tenant.save();
    res.json({ message: 'Tenant updated successfully', tenant });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/super-admin/users ──────────────────────────────────────
router.get('/users', requireSuperAdminLogin, async (req, res, next) => {
  try {
    const { tenantId, search } = req.query;
    const query = {};
    
    if (tenantId) query.tenantId = tenantId;
    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const users = await User.find(query).sort({ createdAt: -1 });
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/super-admin/users/:id ────────────────────────────────
router.patch('/users/:id', requireSuperAdminLogin, async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const { isActive, role, password } = req.body;
    if (isActive !== undefined) user.isActive = isActive;
    if (role !== undefined) user.role = role;
    if (password !== undefined && password.trim() !== '') {
      user.password = password;
    }

    await user.save();
    res.json({ message: 'User updated successfully', user: user.toJSON() });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/super-admin/logs ───────────────────────────────────────
router.get('/logs', requireSuperAdminLogin, async (req, res, next) => {
  try {
    const { tenantId, page = 1, limit = 50 } = req.query;
    const query = {};
    if (tenantId) query.tenantId = tenantId;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [logs, total] = await Promise.all([
      AuditLog.find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('performedBy', 'fullName email')
        .lean(),
      AuditLog.countDocuments(query),
    ]);

    res.json({
      logs,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
