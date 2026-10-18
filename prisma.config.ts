import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 6 CLI configuration.
 *
 * The CLI resolves DATABASE_URL itself when given an explicit `--schema`; this
 * file only exists so `prisma generate` and editor tooling pick up the same
 * schema path. Runtime connection settings live in src/server/db/client.ts.
 */
export default defineConfig({
  schema: path.join('prisma', 'schema.prisma'),
});
