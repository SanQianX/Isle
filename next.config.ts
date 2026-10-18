import type { NextConfig } from 'next';

/**
 * ISLE — Next.js configuration.
 *
 * `output: 'standalone'` produces a self-contained server bundle used by the
 * systemd release layout in DEPLOY_RUNBOOK §6. Note that standalone does NOT
 * copy `public/` or `.next/static` — scripts/deploy.sh does that explicitly.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // Originals are served byte-for-byte from our own route handlers; they must
  // never pass through the image optimizer (DATA_API_STORAGE §3).
  images: {
    unoptimized: true,
  },
  eslint: {
    // Lint runs as its own gate (`npm run lint`) so a lint failure fails the
    // build loudly rather than being silently swallowed.
    ignoreDuringBuilds: true,
  },
  serverExternalPackages: ['sharp', 'busboy', '@prisma/client'],
  experimental: {
    // Upload routes stream large bodies; keep the Node runtime for them.
    proxyTimeout: 120_000,
  },
};

export default nextConfig;
