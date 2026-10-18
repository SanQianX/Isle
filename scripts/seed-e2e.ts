import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/lib/config';
import { getPrisma } from '../src/server/db/client';
import { seedDefaultPlace } from '../src/server/services/place';
import { ingestPhotoBytes } from '../src/server/services/photo';

/**
 * E2E fixture seeding.
 *
 * Photos are ingested through the real ingestion service from the real local
 * fixtures, so the seeded leaderboard contains genuine files with genuine
 * previews and genuine SHA-256s. Seeding Photo rows directly would produce
 * leaderboard entries pointing at files that do not exist — exactly the broken
 * image state the contract forbids.
 */

export type E2EFixtureSummary = {
  places: number;
  photos: number;
  votes: number;
};

/** Fixture -> rank weight. Deterministic so visual baselines are stable. */
const SEED_PLAN: Array<{ file: string; title: string; description: string; upvotes: number }> = [
  {
    file: 'landscape.jpg',
    title: '从云端经过桂山岛',
    description: '飞机上看到的海湾',
    upvotes: 13,
  },
  { file: 'portrait.jpg', title: '灯塔亮起的时候', description: '傍晚走回码头的路上', upvotes: 11 },
  { file: 'square.png', title: '码头上的午后', description: '', upvotes: 10 },
  { file: 'extreme-wide.webp', title: '还没靠岸', description: '船上的水平线', upvotes: 8 },
  { file: 'landscape-2.jpg', title: '雨后的礁石', description: '', upvotes: 6 },
  { file: 'extreme-tall.jpg', title: '渔船归港', description: '竖着拍的那一张', upvotes: 4 },
  { file: 'small.jpeg', title: '一只小螺', description: '', upvotes: 1 },
];

export async function seedE2EFixtures(): Promise<E2EFixtureSummary> {
  const config = getConfig();
  const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');
  const place = await seedDefaultPlace();
  const prisma = await getPrisma();

  // Already seeded? Idempotent, so a re-run does not double the leaderboard.
  const existing = await prisma.photo.count({ where: { placeId: place.id } });
  if (existing > 0) {
    const votes = await prisma.vote.count();
    return { places: 1, photos: existing, votes };
  }

  // Two deterministic visitors: one owns the photos, one votes.
  const author = await ensureVisitor('seed-author');
  const voter = await ensureVisitor('seed-voter');

  let photos = 0;
  let votes = 0;

  for (const [index, plan] of SEED_PLAN.entries()) {
    const bytes = new Uint8Array(await fs.readFile(path.join(fixturesDir, plan.file)));
    const mime = plan.file.endsWith('.png')
      ? 'image/png'
      : plan.file.endsWith('.webp')
        ? 'image/webp'
        : 'image/jpeg';

    const photo = await ingestPhotoBytes({
      placeId: place.id,
      visitorId: author.visitorId,
      bytes,
      fileName: plan.file,
      mime,
      title: plan.title,
      description: plan.description,
      idempotencyKey: `seed-${plan.file}`,
    });
    photos += 1;

    // `upvotes` extra voters beyond the author, each a distinct Visitor so the
    // per-visitor uniqueness constraint is genuinely exercised by the seed.
    for (let voterIndex = 0; voterIndex < plan.upvotes; voterIndex += 1) {
      const extra = await ensureVisitor(`seed-voter-${plan.file}-${voterIndex}`);
      try {
        await prisma.vote.create({
          data: { photoId: photo.id, visitorId: extra.visitorId, value: 1 },
        });
        votes += 1;
      } catch {
        // Duplicate vote for the same (photo, visitor) — the constraint working.
      }
    }

    // A couple of downvotes on the weakest entries so the score column is not
    // uniformly positive and the tie-breakers have something to sort.
    if (index >= SEED_PLAN.length - 2) {
      try {
        await prisma.vote.create({
          data: { photoId: photo.id, visitorId: voter.visitorId, value: -1 },
        });
        votes += 1;
      } catch {
        // Already voted above.
      }
    }
  }

  if (config.isE2E) {
    console.log(`[seed-e2e] ${photos} photos, ${votes} votes under ${place.name}`);
  }

  return { places: 1, photos, votes };
}

/** Deterministic visitor for a given seed label, reused across runs. */
async function ensureVisitor(label: string): Promise<{ visitorId: string }> {
  const tokenHash = createHash('sha256').update(`seed:${label}`).digest('hex');
  const prisma = await getPrisma();

  const existing = await prisma.visitor.findUnique({ where: { tokenHash } });
  if (existing !== null) return { visitorId: existing.id };

  // Display codes are unique; derive one deterministically and retry on the
  // vanishingly unlikely collision.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const displayCode = createHash('sha256')
      .update(`seed:${label}:${attempt}`)
      .digest('hex')
      .slice(0, 6);
    try {
      const created = await prisma.visitor.create({ data: { tokenHash, displayCode } });
      return { visitorId: created.id };
    } catch {
      // displayCode collision; try the next derivation.
    }
  }

  throw new Error(`Unable to allocate a seed display code for ${label}`);
}
