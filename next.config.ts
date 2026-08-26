import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  async redirects() {
    const preview = [
      { source: "/preview", destination: "/", permanent: true },
      { source: "/en/preview", destination: "/en", permanent: true },
    ];
    if (process.env.NODE_ENV !== "development") return preview;

    return [
      ...preview,
      {
        source: "/:path*",
        has: [{ type: "host", value: "127.0.0.1" }],
        destination: "http://localhost:3000/:path*",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
