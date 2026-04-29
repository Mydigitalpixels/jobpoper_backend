const ServiceCategory = require('../models/ServiceCategory');

/**
 * Default seed list. Slug is the stable identifier; name is what users see.
 * To add/rename a category later, push to this list — sortOrder controls list order.
 */
const DEFAULT_CATEGORIES = [
  { slug: 'home-cleaning', name: 'Home Cleaning' },
  { slug: 'maid-services', name: 'Maid Services' },
  { slug: 'deep-cleaning-sanitization', name: 'Deep Cleaning & Sanitization' },
  { slug: 'plumbing', name: 'Plumbing' },
  { slug: 'electrical-services', name: 'Electrical Services' },
  { slug: 'appliance-repair', name: 'Appliance Repair (AC, Fridge, Washing Machine, etc.)' },
  { slug: 'handyman-services', name: 'Handyman Services (minor fixes, installations)' },
  { slug: 'carpentry-woodwork', name: 'Carpentry & Woodwork' },
  { slug: 'home-salon-spa', name: 'Home Salon or Spa' },
  { slug: 'painting-wall-work', name: 'Painting & Wall Work' },
  { slug: 'pest-control', name: 'Pest Control' },
  { slug: 'gardening-landscaping', name: 'Gardening & Landscaping' },
  { slug: 'car-wash-detailing', name: 'Car Wash & Detailing' },
  { slug: 'bike-car-repair', name: 'Bike & Car Repair' },
  { slug: 'moving-shifting', name: 'Moving & Shifting (packers & movers)' },
  { slug: 'tailoring', name: 'Tailoring' },
  { slug: 'delivery-pickup-services', name: 'Delivery & Pickup Services' },
  { slug: 'laundry-dry-cleaning', name: 'Laundry & Dry Cleaning' },
  { slug: 'cooking-home-chef', name: 'Cooking & Home Chef Services' },
  { slug: 'babysitting-child-care', name: 'Babysitting & Child Care' },
  { slug: 'elder-care-nursing', name: 'Elder Care & Nursing Support' },
  { slug: 'pet-care-grooming', name: 'Pet Care & Grooming' },
  { slug: 'security-services', name: 'Security Services (guards, surveillance setup)' },
  { slug: 'event-help', name: 'Event Help (decorators, helpers, catering assistants)' },
  { slug: 'photography-videography', name: 'Photography & Videography' },
  { slug: 'it-tech-support', name: 'IT & Tech Support (WiFi setup, laptop repair, etc.)' },
  { slug: 'tutoring-home-classes', name: 'Tutoring & Home Classes' },
  { slug: 'fitness-personal-training', name: 'Fitness & Personal Training' },
  { slug: 'others', name: 'Others' },
];

/**
 * Idempotent seeder — safe to run on every server start. It:
 *  - inserts any new categories that don't exist (matched by slug)
 *  - updates the display name & sortOrder if they've drifted
 *  - never touches `isActive` so admins can deactivate categories without them being re-enabled
 */
async function seedServiceCategories() {
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

    const result = await ServiceCategory.bulkWrite(ops, { ordered: false });
    const inserted = result.upsertedCount || 0;
    const matched = result.matchedCount || 0;
    console.log(
      `[ServiceCategory] Seed complete: ${inserted} inserted, ${matched} synced (total provided: ${ops.length})`
    );
  } catch (error) {
    console.error('[ServiceCategory] Seed failed:', error.message);
  }
}

module.exports = { seedServiceCategories, DEFAULT_CATEGORIES };
