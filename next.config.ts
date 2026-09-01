import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Sanity-hosted images (course covers, lesson posters) rendered through next/image.
    remotePatterns: [{ protocol: "https", hostname: "cdn.sanity.io", pathname: "/images/**" }],
  },
};

export default nextConfig;
