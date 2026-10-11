/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Onboarding uploads (up to 4 MB each) go through a server action.
    serverActions: { bodySizeLimit: "5mb" },
  },
  async headers() {
    const privateLink = [
      // Customer links carry their token in the path: never leak it to other sites.
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
      { key: "Cache-Control", value: "private, no-store" },
      { key: "X-Frame-Options", value: "DENY" },
    ];
    return [
      { source: "/start/:path*", headers: privateLink },
      { source: "/review/:path*", headers: privateLink },
    ];
  },
};

export default nextConfig;
