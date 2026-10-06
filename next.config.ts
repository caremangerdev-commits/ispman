import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Where `next build` writes. `.next` unless NEXT_DIST_DIR says otherwise.
   *
   * deploy.sh builds into `.next-staging` so the build never touches the
   * `.next` the running app is serving from, then swaps the folders only once
   * the build has succeeded. Building in place deletes the live app's CSS and
   * JS mid-build — that is what took the site down on 6 Oct 2026. Nothing else
   * sets this, so `next dev`, `next start` and a plain `npm run build` behave
   * exactly as before.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /**
   * mysql2 must not be bundled.
   *
   * It builds protocol commands with dynamic requires and code generation; when
   * the bundler rewrites those, `pool.query()` still works but `pool.execute()`
   * (prepared statements) fails at the wire level with ECONNRESET. Marking the
   * package external makes the server require it from node_modules as-is.
   */
  serverExternalPackages: ["mysql2"],
};

export default nextConfig;
