const nextConfig = {
  reactStrictMode: true,
  // e2e 构建产物隔离到独立目录(如 .next-e2e),避免覆盖运行中开发栈的 .next
  distDir: process.env.NEXT_DIST_DIR || ".next"
};

export default nextConfig;
