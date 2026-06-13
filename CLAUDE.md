# LearningLoopAI V1

## 服务启动 / 重启

根目录 npm scripts（封装 start-services.sh / stop-services.sh）：

```bash
npm run start          # 启动全部服务
npm run stop           # 停止全部服务
npm run restart        # 重启（不重新 build）
npm run restart:full   # 重启 + 重新 build（改了前端构建相关配置时用）
```

启动后的服务：

- 前端 (Next.js): http://127.0.0.1:3000
- BFF (Node): http://127.0.0.1:4000
- AI 服务 (FastAPI): http://127.0.0.1:8000

日志在 `.omx/logs/split-services/`（frontend.log / bff.log / ai-service.log），PID 文件在 `.omx/state/split-services/`。

## 常用验证

```bash
node --test tests/unit/<file>.test.js   # 单测
npm run verify:real                     # 用现有服务跑核心 e2e（要求 3000/4000 已起）
```
