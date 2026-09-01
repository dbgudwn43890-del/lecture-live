import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 워크스페이스가 한 컴포넌트라 세그먼트·스트리밍 델타마다 전체가 다시
  // 그려진다. 컴파일러가 자동 메모이제이션으로 바뀐 부분만 그리게 한다.
  reactCompiler: true,
  allowedDevOrigins: ["127.0.0.1"],
  // PDF.js uses Node-only modules while reading uploaded files. Keep it out of
  // the route bundle so Vercel runs the package's server build unchanged.
  serverExternalPackages: ["pdfjs-dist"],
  // PDF.js dynamically imports this worker, which static tracing cannot see.
  outputFileTracingIncludes: {
    "/api/materials": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
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
