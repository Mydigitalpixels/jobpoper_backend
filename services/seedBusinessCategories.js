const BusinessCategory = require('../models/BusinessCategory');

/**
 * Default seed list. Slug is the stable identifier; name is what users see.
 * To add/rename a category later, push to this list — sortOrder controls list order.
 *
 * Order is intentional: "Others" stays last.
 */
const DEFAULT_CATEGORIES = [
  { slug: 'restaurants-food-services', name: 'Restaurants & Food Services' },
  { slug: 'grocery-general-stores', name: 'Grocery & General Stores' },
  { slug: 'fruits-vegetable-vendors', name: 'Fruits & Vegetable Vendors' },
  { slug: 'meat-seafood-shops', name: 'Meat & Seafood Shops' },
  { slug: 'bakeries-sweets', name: 'Bakeries & Sweets' },
  { slug: 'cafes-tea-stalls', name: 'Cafes & Tea Stalls' },
  { slug: 'clothing-fashion-stores', name: 'Clothing & Fashion Stores' },
  { slug: 'footwear-shops', name: 'Footwear Shops' },
  { slug: 'bags-accessories', name: 'Bags & Accessories' },
  { slug: 'jewelry-shops', name: 'Jewelry Shops' },
  { slug: 'salons-barber-shops', name: 'Salons & Barber Shops' },
  { slug: 'spa-wellness-centers', name: 'Spa & Wellness Centers' },
  { slug: 'beauty-cosmetics-stores', name: 'Beauty & Cosmetics Stores' },
  { slug: 'electrical-services', name: 'Electrical Services' },
  { slug: 'plumbing-services', name: 'Plumbing Services' },
  { slug: 'carpentry-woodwork', name: 'Carpentry & Woodwork' },
  { slug: 'home-cleaning-services', name: 'Home Cleaning Services' },
  { slug: 'pest-control-services', name: 'Pest Control Services' },
  { slug: 'automobile-services', name: 'Automobile Services (Car/Bike Repair, Washing)' },
  { slug: 'fuel-oil-vendors', name: 'Fuel & Oil Vendors' },
  { slug: 'mobile-electronics-stores', name: 'Mobile & Electronics Stores' },
  { slug: 'computer-it-services', name: 'Computer & IT Services' },
  { slug: 'tailoring-alteration-services', name: 'Tailoring & Alteration Services' },
  { slug: 'laundry-dry-cleaning', name: 'Laundry & Dry Cleaning' },
  { slug: 'pet-care-veterinary-services', name: 'Pet Care & Veterinary Services' },
  { slug: 'construction-contractors', name: 'Construction & Contractors' },
  { slug: 'hardware-building-materials', name: 'Hardware & Building Materials' },
  { slug: 'event-services', name: 'Event Services (Decorators, Photographers)' },
  { slug: 'education-coaching-centers', name: 'Education & Coaching Centers' },
  { slug: 'fitness-sports', name: 'Fitness & Sports (Gyms, Trainers, Yoga)' },
  { slug: 'others', name: 'Others' },
];

/**
 * Idempotent seeder — safe to run on every server start. It:
 *  - inserts any new categories that don't exist (matched by slug)
 *  - updates the display name & sortOrder if they've drifted
 *  - never touches `isActive` so admins can deactivate categories without them being re-enabled
 */
async function seedBusinessCategories() {
  try {
    const ops = DEFAULT_CATEGORIES.map((category, index) => ({
      updateOne: {
        filter: { slug: category.slug },
        update: {
          $setOnInsert: { isActive: true },
          $set: {
            name: category.name,
            slug: category.slug,
            sortOrder: index,
          },
        },
        upsert: true,
      },
    }));

    if (ops.length === 0) return;

    const result = await BusinessCategory.bulkWrite(ops, { ordered: false });
    const inserted = result.upsertedCount || 0;
    const matched = result.matchedCount || 0;
    console.log(
      `[BusinessCategory] Seed complete: ${inserted} inserted, ${matched} synced (total provided: ${ops.length})`
    );
  } catch (error) {
    console.error('[BusinessCategory] Seed failed:', error.message);
  }
}

module.exports = { seedBusinessCategories, DEFAULT_CATEGORIES };
