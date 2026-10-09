import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Native/wasm database drivers stay outside the server bundle.
  serverExternalPackages: ["postgres", "@electric-sql/pglite"],
};

export default config;
