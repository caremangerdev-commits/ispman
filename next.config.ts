import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
