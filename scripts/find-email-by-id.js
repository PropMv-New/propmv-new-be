require('../src/config/loadEnv');
const { connectDB, disconnectDB } = require('../src/config/db.config');
const Email = require('../src/shared/email/model/email.model');

async function main() {
  await connectDB();

  const email = await Email.findById('6a6edd0591d4e01011ee31f2')
    .populate('senderId', 'firstName lastName email role companyRoleId')
    .populate('receiverId', 'firstName lastName email role companyRoleId')
    .lean();

  if (!email) {
    console.log(' No email found with that ID');
    await disconnectDB();
    return;
  }

  console.log('\n===== EMAIL RECORD =====');
  console.log('ID:        ', String(email._id));
  console.log('Subject:   ', email.subject);
  console.log('Content:   ', email.content);
  console.log('Is Read:   ', email.isRead);
  console.log('Read At:   ', email.readAt || 'N/A');
  console.log('Is Deleted:', email.isDeleted);
  console.log('Created At:', email.createdAt);

  console.log('\n===== SENDER =====');
  if (email.senderId) {
    console.log('ID:   ', String(email.senderId._id));
    console.log('Name: ', `${email.senderId.firstName} ${email.senderId.lastName}`);
    console.log('Email:', email.senderId.email);
  } else {
    console.log('Sender not found or deleted');
  }

  console.log('\n===== RECEIVER =====');
  if (email.receiverId) {
    console.log('ID:   ', String(email.receiverId._id));
    console.log('Name: ', `${email.receiverId.firstName} ${email.receiverId.lastName}`);
    console.log('Email:', email.receiverId.email);
  } else {
    console.log('Receiver not found or deleted');
  }

  await disconnectDB();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
