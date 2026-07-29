const mongoose = require('mongoose');

const connectDB = async () => {
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
      });
      console.log('✅ MongoDB Atlas connected');
      return;
    } catch (err) {
      attempt++;
      console.error(`❌ MongoDB connection attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`   Retrying in 3 seconds...`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        console.error('   Max retries reached. Exiting process.');
        process.exit(1);
      }
    }
  }
};

// Graceful disconnect on app shutdown
process.on('SIGINT', async () => {
  await mongoose.connection.close();
  console.log('MongoDB connection closed (app shutdown)');
  process.exit(0);
});

module.exports = connectDB;
