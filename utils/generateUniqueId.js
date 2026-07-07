/**
 * Generates a random alphanumeric ID (uppercase A-Z + 0-9).
 * Pool: 36 chars, length 5 → 60,466,176 possible combinations.
 *
 * @param {number} length - Default 5
 * @returns {string} e.g. "JP4X2"
 */
const generateId = (length = 5) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
};

/**
 * Generates a unique Worker ID not already used in the User collection.
 * @param {Model} UserModel - Mongoose User model
 * @returns {Promise<string>}
 */
const generateUniqueWorkerId = async (UserModel) => {
  let id;
  let exists = true;
  while (exists) {
    id = generateId(5);
    const doc = await UserModel.findOne({ workerId: id }).select('_id');
    exists = !!doc;
  }
  return id;
};

/**
 * Generates a unique Job PIN not already used in the Job collection.
 * @param {Model} JobModel - Mongoose Job model
 * @returns {Promise<string>}
 */
const generateUniqueJobPin = async (JobModel) => {
  let pin;
  let exists = true;
  while (exists) {
    pin = generateId(5);
    const doc = await JobModel.findOne({ jobPin: pin }).select('_id');
    exists = !!doc;
  }
  return pin;
};

module.exports = { generateId, generateUniqueWorkerId, generateUniqueJobPin };
