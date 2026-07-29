require('dotenv').config();
const mongoose = require('mongoose');
const SuperAdmin = require('./models/SuperAdmin');

async function createSuperAdmin() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const email = 'superadmin@vmm.com';
    const password = 'SuperPassword123!';
    const fullName = 'Platform Super Admin';

    // Check if it already exists
    const existing = await SuperAdmin.findOne({ email });
    if (existing) {
      console.log(`⚠️ Super Admin with email ${email} already exists.`);
      process.exit(0);
    }

    await SuperAdmin.create({
      fullName,
      email,
      password
    });

    console.log(`🎉 Super Admin created successfully!`);
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);

  } catch (err) {
    console.error('❌ Error creating Super Admin:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
  }
}

createSuperAdmin();
