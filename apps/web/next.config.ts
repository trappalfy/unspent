import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Native/wasm database drivers stay outside the server bundle.
  serverExternalPackages: ["postgres", "@electric-sql/pglite"],
};

// Docs pages live in content/docs/*.mdx. Plugins are named by string so Turbopack can load them.
const withMDX = createMDX({
  options: {
    remarkPlugins: ["remark-gfm"],
    rehypePlugins: ["rehype-slug"],
  },
});

export default withMDX(config);
