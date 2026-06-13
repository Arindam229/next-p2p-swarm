import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // simple-peer's dependency chain (readable-stream, buffer, randombytes)
  // expects Node core modules that aren't bundled for the browser by
  // default. Alias them to their browser-safe npm equivalents for both
  // bundlers.
  turbopack: {
    resolveAlias: {
      buffer: "buffer",
      process: "process/browser",
    },
  },
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      buffer: require.resolve("buffer/"),
      process: require.resolve("process/browser"),
    };
    return config;
  },
};

export default nextConfig;
