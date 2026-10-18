import { seedDefaultPlace } from '../src/server/services/place';

/**
 * E2E fixture seeding.
 *
 * Phase 02 scope: places and visitors only — the Photo/Vote fixtures that
 * ranking and lightbox scenarios need are added in Phase 03/04 once originals
 * and derivatives actually exist on disk. Seeding fake Photo rows before then
 * would produce ranking entries pointing at files that do not exist, which is
 * exactly the "broken image on the leaderboard" state the contract forbids.
 */
export type E2EFixtureSummary = {
  places: number;
  photos: number;
  votes: number;
};

export async function seedE2EFixtures(): Promise<E2EFixtureSummary> {
  await seedDefaultPlace();
  return { places: 1, photos: 0, votes: 0 };
}
