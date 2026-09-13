import type { NextConfig } from "next";

function origin(value: string | undefined) {
  try { return value ? new URL(value).origin : ""; } catch { return ""; }
}
const supabaseOrigin = origin(process.env.NEXT_PUBLIC_SUPABASE_URL);
const supabaseStorageOrigin = supabaseOrigin.replace(/\.supabase\.co$/, ".storage.supabase.co");
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  // Next's static HTML contains hydration scripts; a nonce would require dynamic rendering.
  `script-src 'self' 'unsafe-inline' ${process.env.NODE_ENV === "development" ? "'unsafe-eval'" : ""} https://cdn.paddle.com https://challenges.cloudflare.com https://www.googletagmanager.com`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https://*.googleusercontent.com ${supabaseOrigin} https://*.paddle.com`,
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseOrigin} ${supabaseStorageOrigin} ${supabaseOrigin.replace(/^https:/, "wss:")} ${origin(process.env.STT_RELAY_URL)} ${origin(process.env.PHONE_MIC_RELAY_URL).replace(/^https:/, "wss:")} https://*.paddle.com https://challenges.cloudflare.com https://www.google-analytics.com https://region1.google-analytics.com ${process.env.NODE_ENV === "development" ? "ws://localhost:3000" : ""}`,
  `media-src 'self' blob: ${supabaseOrigin}`,
  "worker-src 'self' blob:",
  "frame-src 'self' blob: https://*.paddle.com https://challenges.cloudflare.com",
  "form-action 'self' https://*.paddle.com",
].join("; ");

const nextConfig: NextConfig = {
  // 워크스페이스가 한 컴포넌트라 세그먼트·스트리밍 델타마다 전체가 다시
  // 그려진다. 컴파일러가 자동 메모이제이션으로 바뀐 부분만 그리게 한다.
  reactCompiler: true,
  devIndicators: { position: "bottom-right" },
  allowedDevOrigins: ["127.0.0.1"],
  // PDF.js uses Node-only modules while reading uploaded files. Keep it out of
  // the route bundle so Vercel runs the package's server build unchanged.
  serverExternalPackages: ["pdfjs-dist"],
  // PDF.js dynamically imports this worker, which static tracing cannot see.
  outputFileTracingIncludes: {
    "/api/materials": ["./app/lib/material-pdf-worker.mjs", "./.pdfjs/material-pdf.worker.mjs", "./node_modules/pdfjs-dist/legacy/build/pdf.mjs"],
    "/api/ask": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/lecture-audio": ["./.ffmpeg/ffmpeg"],
  },
  async headers() {
    return [
      {
        source: "/_next/static/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          // 마이크·탭 오디오 캡처(display-capture)는 워크스페이스가 쓰고, 나머지 강력 권한은 어디서도 안 쓴다.
          { key: "Permissions-Policy", value: "camera=(), geolocation=(), display-capture=(self), payment=(self https://buy.paddle.com https://sandbox-buy.paddle.com)" },
        ],
      },
      {
        source: "/api/analytics/frame",
        // Only the empty measurement document may be embedded by this origin.
        // Keep the product pages protected by the default DENY policy above.
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; connect-src https://www.google-analytics.com https://region1.google-analytics.com; img-src https://www.google-analytics.com https://region1.google-analytics.com; form-action 'none'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        source: "/phone-mic",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
  async redirects() {
    const preview = [
      { source: "/preview", destination: "/", permanent: true },
      { source: "/en/preview", destination: "/en", permanent: true },
      // Retired pricing links still appear in Search Console and old sign-in destinations.
      ...["/월", "/4개월", "/month"].map(source => ({
        source: encodeURI(source), destination: "/billing", permanent: true,
      })),
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
