/** @type {import('next').NextConfig} */
const nextConfig = {
  // Fully static HTML/JS/CSS export — no Node.js runtime needed at serve time.
  // Build output lands in ./out (publish directory for Coolify; Vercel auto-detects).
  output: 'export',
  reactStrictMode: true,
  // Static export cannot use the Next.js image optimizer.
  images: { unoptimized: true },
  // Emit /flash/index.html, /field/index.html, etc. so static hosts resolve routes.
  trailingSlash: true,
};

module.exports = nextConfig;
