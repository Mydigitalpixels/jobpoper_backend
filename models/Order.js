const mongoose = require('mongoose');

/**
 * Order
 * ------
 * A customer-raised order against a specific business profile.
 *
 * Created from the "Raise an Order" modal on the user-side BusinessDetailScreen.
 * The customer (the authenticated user) fills in their contact details and an
 * optional service/product description; the business owner sees the order in
 * their Orders Screen and can call or navigate to the customer.
 *
 * Notes:
 *   - `customer` is set from the auth middleware (req.user._id) so we always
 *     have a trail back to the source user, even if the snapshot fields are
 *     edited at submit time.
 *   - `businessOwner` is denormalized from `businessProfile.user` at create
 *     time so we can answer "give me my orders" without a join.
 *   - `customerName` / `customerPhone` / `customerLocation` are stored as
 *     plain strings (not refs) — the spec says they are editable at submit,
 *     so we must capture the exact value the customer typed.
 *   - `isRead` powers the header bell-style badge on the business side.
 */
const orderSchema = new mongoose.Schema(
  {
    businessProfile: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BusinessProfile',
      required: [true, 'Business profile is required'],
      index: true,
    },
    businessOwner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Business owner is required'],
      index: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Customer is required'],
      index: true,
    },
    customerName: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true,
      maxlength: [100, 'Name cannot be more than 100 characters'],
    },
    customerPhone: {
      type: String,
      required: [true, 'Customer phone number is required'],
      trim: true,
      match: [/^\+?[1-9]\d{1,14}$/, 'Please enter a valid phone number'],
    },
    customerLocation: {
      type: String,
      trim: true,
      maxlength: [300, 'Location cannot be more than 300 characters'],
      default: '',
    },
    serviceDetail: {
      type: String,
      trim: true,
      maxlength: [2000, 'Service/Product detail cannot be more than 2000 characters'],
      default: '',
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true, collection: 'orders' }
);

// Compound indexes — the two queries we actually run are
// "all orders for business owner X newest first" and
// "unread count for business owner X". Both are covered here.
orderSchema.index({ businessOwner: 1, createdAt: -1 });
orderSchema.index({ businessOwner: 1, isRead: 1 });

module.exports = mongoose.model('Order', orderSchema);
