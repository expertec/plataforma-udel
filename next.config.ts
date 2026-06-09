import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // ffmpeg-static resuelve la ruta de su binario con __dirname; si webpack lo
  // empaqueta, __dirname queda mal y el spawn falla con ENOENT. Excluirlo del
  // bundle del servidor mantiene la ruta real en node_modules.
  serverExternalPackages: ["ffmpeg-static"],
  images: {
    formats: ["image/webp"],
    deviceSizes: [360, 640, 768, 1024, 1280],
    imageSizes: [48, 64, 80, 96, 128, 256],
    minimumCacheTTL: 60 * 60 * 24 * 30,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "i.pravatar.cc",
      },
      {
        protocol: "https",
        hostname: "firebasestorage.googleapis.com",
      },
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
  },
};

export default nextConfig;
