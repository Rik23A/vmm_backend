const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Tenant = require('../models/Tenant');
const AuditLog = require('../models/AuditLog');
const VendorInvitation = require('../models/VendorInvitation');
const { requireLogin, requireRole } = require('../middleware/auth');

// ── Helper: generate JWT ────────────────────────────────────────────
const signToken = (user) => jwt.sign(
  { userId: user._id, tenantId: user.tenantId, role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);

// ── POST /api/auth/register ──────────────────────────────────────────
// Creates the FIRST admin for a new tenant OR (if authenticated ADMIN) creates any user
router.post('/register', [
  body('fullName').trim().notEmpty().withMessage('Full name is required'),
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('tenantId').trim().notEmpty().withMessage('Tenant ID is required')
    .matches(/^[a-z0-9_-]+$/).withMessage('Tenant ID: lowercase letters, numbers, hyphens only'),
  body('companyName').optional().trim(),
  body('role').optional().isIn(['REQUESTOR', 'L1_APPROVER', 'L2_APPROVER', 'MASTER_DATA', 'ADMIN']),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { fullName, email, password, tenantId, companyName, role } = req.body;

    // Check if tenant exists
    let tenant = await Tenant.findOne({ tenantId });

    // If tenant doesn't exist — this is the first registration (creates ADMIN)
    if (!tenant) {
      if (!companyName) {
        return res.status(400).json({ message: 'companyName is required for new tenant registration' });
      }
      tenant = await Tenant.create({
        tenantId,
        companyName,
        sapConfig: { sapVersion: 'STUB' },
      });
    } else {
      // Tenant exists — only an authenticated ADMIN of this tenant can add users
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(403).json({ message: 'Only an admin can add users to an existing tenant. Please log in.' });
      }
      // Verify the token
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded.tenantId !== tenantId || decoded.role !== 'ADMIN') {
          return res.status(403).json({ message: 'Only an ADMIN of this tenant can add new users.' });
        }
      } catch {
        return res.status(401).json({ message: 'Invalid or expired token.' });
      }
    }

    // Check for duplicate email within tenant
    const exists = await User.findOne({ email, tenantId });
    if (exists) {
      return res.status(409).json({ message: 'A user with this email already exists in your organization.' });
    }

    // First user of tenant is always ADMIN
    const existingUserCount = await User.countDocuments({ tenantId });
    const assignedRole = existingUserCount === 0 ? 'ADMIN' : (role || 'REQUESTOR');

    const user = await User.create({ fullName, email, password, tenantId, role: assignedRole });

    await AuditLog.log({
      tenantId,
      action: 'USER_CREATED',
      performedByName: 'System',
      changes: [{ field: 'email', newValue: email }, { field: 'role', newValue: assignedRole }],
    });

    const token = signToken(user);
    res.status(201).json({
      message: 'User created successfully',
      token,
      user: user.toJSON(),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/login ─────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().withMessage('Valid email is required').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
  body('tenantId').trim().notEmpty().withMessage('Tenant ID is required'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password, tenantId } = req.body;

    // Fetch user with password (select: false by default)
    const user = await User.findOne({ email, tenantId }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email, password, or tenant ID.' });
    }
    if (!user.isActive) {
      return res.status(403).json({ message: 'Your account has been deactivated. Contact your administrator.' });
    }

    // Check tenant is active
    const tenant = await Tenant.findOne({ tenantId, isActive: true });
    if (!tenant) {
      return res.status(403).json({ message: 'Your organization account is inactive. Contact support.' });
    }

    // Enforce subscription rules only in MULTI-tenant mode
    if (process.env.TENANT_MODE !== 'SINGLE') {
      const now = new Date();
      const isTrialExpired = tenant.subscription.plan === 'TRIAL' && tenant.subscription.trialEndsAt && tenant.subscription.trialEndsAt < now;
      const isPaidExpired = tenant.subscription.paidUntil && tenant.subscription.paidUntil < now;

      if (tenant.subscription.status === 'SUSPENDED') {
        return res.status(403).json({ message: 'Your organization subscription is suspended. Contact support.' });
      }
      if (tenant.subscription.status === 'EXPIRED' || isTrialExpired || isPaidExpired) {
        return res.status(403).json({ message: 'Your organization subscription has expired. Contact support.' });
      }
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    await AuditLog.log({
      tenantId, action: 'LOGIN',
      performedBy: user._id, performedByName: user.fullName, performedByRole: user.role,
      ipAddress: req.ip,
    });

    const token = signToken(user);
    res.json({
      token,
      user: user.toJSON(),
      tenant: { companyName: tenant.companyName, plan: tenant.subscription.plan, plants: tenant.plants || [] },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────
router.get('/me', requireLogin, async (req, res) => {
  const tenant = await Tenant.findOne({ tenantId: req.tenantId });
  res.json({
    user: req.user,
    tenant: tenant ? {
      companyName: tenant.companyName,
      plan: tenant.subscription.plan,
      status: tenant.subscription.status,
      sapVersion: tenant.sapConfig?.sapVersion,
      plants: tenant.plants || [],
    } : null,
  });
});

// ── POST /api/auth/logout ─────────────────────────────────────────────
// JWT is stateless — logout is handled client-side by deleting the token.
// This endpoint just logs the event.
router.post('/logout', requireLogin, async (req, res) => {
  await AuditLog.log({
    tenantId: req.tenantId, action: 'LOGOUT',
    performedBy: req.user._id, performedByName: req.user.fullName,
    ipAddress: req.ip,
  });
  res.json({ message: 'Logged out successfully. Please delete the token on the client.' });
});

// ── POST /api/auth/change-password ────────────────────────────────────
router.post('/change-password', requireLogin, [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { currentPassword, newPassword } = req.body;
    
    // Fetch the user with password field included
    const user = await User.findById(req.user._id).select('+password');
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Compare passwords
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ message: 'Incorrect current password' });
    }

    // Set new password
    user.password = newPassword;
    user.isFirstLogin = false; // Mark first login as complete
    await user.save();

    await AuditLog.log({
      tenantId: req.tenantId,
      action: 'PASSWORD_CHANGED',
      performedBy: user._id,
      performedByName: user.fullName,
      performedByRole: user.role,
      changes: [{ field: 'password', newValue: '[changed]' }]
    });

    res.json({ message: 'Password changed successfully', user: user.toJSON() });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/invitation/:token ──────────────────────────────────
router.get('/invitation/:token', async (req, res, next) => {
  try {
    const { token } = req.params;
    const invitation = await VendorInvitation.findOne({ token, status: 'PENDING' });
    
    if (!invitation) {
      return res.status(404).json({ message: 'Invalid or expired invitation token.' });
    }
    
    if (invitation.expiresAt < new Date()) {
      invitation.status = 'EXPIRED';
      await invitation.save();
      return res.status(400).json({ message: 'This invitation has expired.' });
    }

    res.json({
      message: 'Token is valid',
      vendorName: invitation.vendorName,
      tradeName: invitation.tradeName || '',
      email: invitation.email,
      sapVendorNumber: invitation.sapVendorNumber,
      tenantId: invitation.tenantId
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/vendor-register ───────────────────────────────────
router.post('/vendor-register', [
  body('token').notEmpty().withMessage('Token is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { token, password } = req.body;
    
    const invitation = await VendorInvitation.findOne({ token, status: 'PENDING' });
    if (!invitation) {
      return res.status(404).json({ message: 'Invalid or expired invitation token.' });
    }
    
    if (invitation.expiresAt < new Date()) {
      invitation.status = 'EXPIRED';
      await invitation.save();
      return res.status(400).json({ message: 'This invitation has expired.' });
    }
    
    // Check if user already exists
    let existingUser = await User.findOne({ email: invitation.email, tenantId: invitation.tenantId });
    if (existingUser) {
      return res.status(409).json({ message: 'A user with this email already exists in the system.' });
    }
    
    // Create the vendor user
    const user = await User.create({
      fullName: invitation.vendorName,
      email: invitation.email,
      password: password,
      tenantId: invitation.tenantId,
      role: 'REQUESTOR', // Assigning existing REQUESTOR role as confirmed by user
      sapVendorNumber: invitation.sapVendorNumber,
      isFirstLogin: false // They just set their password
    });
    
    // Mark invitation as registered
    invitation.status = 'REGISTERED';
    await invitation.save();

    await AuditLog.log({
      tenantId: invitation.tenantId,
      action: 'USER_CREATED',
      performedByName: 'System',
      changes: [
        { field: 'email', newValue: invitation.email }, 
        { field: 'role', newValue: 'REQUESTOR' },
        { field: 'sapVendorNumber', newValue: invitation.sapVendorNumber }
      ],
    });

    const authToken = signToken(user);
    res.status(201).json({
      message: 'Vendor account created successfully',
      token: authToken,
      user: user.toJSON(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
