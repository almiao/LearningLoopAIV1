# labs/superapp — 暂搁的 superapp / 提醒推送链路

> 状态:**Labs(暂搁,未来可启用)**。不是已废弃。superapp 形态(飞书 / 微信定时提醒 → 拉用户回到一条可回复的学习问题)未来会接回来。
> 按 PRODUCT.md §4 / §7,提醒先做成站内 Today Queue 视图;外部渠道分发是 Goal 状态的下游,等账本(§4)立起来再接。

## 为什么搁这里,而不是删

- `superapp-service`(飞书/微信渠道编排)是独立 Node 服务,和主产品 mastery 引擎零共享,留在主仓库只会分散注意力(违反"单引擎聚焦")。
- 但它的核心逻辑(`yesterday_gap_followup / forgetting_point_review / interrupted_learning_recovery` 三类提醒候选)未来喂 Today Queue 时有用,所以**冻结、不丢弃**。

## 这里有什么

```
labs/superapp/
  README.md                      ← 本文件
  service/                       ← 原 superapp-service/(git mv,历史保留)。自包含,经 HTTP 调 BFF/AI
  ai-service-endpoints.py.txt    ← 从 ai-service/app/main.py 摘掉的两个端点 + helpers,可贴回
  bff-routes.js.txt              ← 从 bff/src/server.js 摘掉的 import/const/handler/routes,可贴回
  start-services.snippet.sh      ← 从 start-services.sh 摘掉的启动行,可贴回
```

## 留在主仓库、**没**搬走的(故意)

| 留下的 | 原因 |
|---|---|
| `src/superapp/reminder-candidate.js` | 提醒候选生成逻辑,未来 Today Queue 可能复用 → 当可复用资产留在主 `src/`。现已无 BFF 消费者(孤儿,已加 DEPRECATED 注释)。其单测 `tests/unit/superapp/` 仍在跑 |
| `/api/superapp/answer-knowledge-question`(ai-service) | **名字带 superapp 但其实是主产品的知识 QA**,被 `/learn` 划词提问经 BFF `/api/knowledge/answer` 调用。**必须留**,不要误删 |

## 怎么复活(未来要用时)

1. `service/`:把 `git mv labs/superapp/service superapp-service`(或留原位),`npm install --prefix labs/superapp/service`。
2. `ai-service-endpoints.py.txt`:两个端点 + helpers 贴回 `ai-service/app/main.py`(`SuperappTaskRequest`/`SuperappContinueRequest` 两个 model 还在 main.py,无需重建)。
3. `bff-routes.js.txt`:4 个贴点(import / const / handler / routes)贴回 `bff/src/server.js`。
4. `start-services.snippet.sh`:启动行贴回 `start-services.sh`,`--prefix` 指向服务新位置;`package.json` 加回 `dev:superapp`。
5. 跑 `npm start`,`curl http://127.0.0.1:4100/api/health` 验活。

> 复活成本 ≈ 贴 4 处片段 + 一个 npm install。这就是"暂搁而非删除"的意义。
