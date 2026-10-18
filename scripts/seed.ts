/**
 * Seed the default place, and optionally the E2E fixture set.
 *
 * Idempotent: safe to run on every boot. Keyed on `Place.normalizedName`, so a
 * second run updates nothing rather than creating a duplicate 桂山岛.
 *
 * Usage:
 *   npx tsx scripts/seed.ts          # production-shaped: just the default place
 *   npx tsx scripts/seed.ts --e2e    # plus deterministic E2E fixtures
 */
import { getConfig } from '../src/lib/config';
import { getPrisma } from '../src/server/db/client';
import { seedDefaultPlace } from '../src/server/services/place';
import { seedE2EFixtures } from './seed-e2e';

async function main(): Promise<void> {
  const config = getConfig();
  const isE2E = process.argv.includes('--e2e');

  if (isE2E && !config.isE2E) {
    throw new Error('Refusing to seed E2E fixtures without ISLE_E2E=1.');
  }

  const place = await seedDefaultPlace();
  console.log(`[seed] default place ready: ${place.name} (slug=${place.slug}, id=${place.id})`);

  if (isE2E) {
    const summary = await seedE2EFixtures();
    console.log(
      `[seed] E2E fixtures: ${summary.places} places, ${summary.photos} photos, ${summary.votes} votes`,
    );
  }

  // Warm the connection so the first request does not pay for it.
  await getPrisma();
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('[seed] failed:', error);
    process.exit(1);
  });
