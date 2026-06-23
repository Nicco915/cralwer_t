# Load Test

压力测试：验证单机 4 通道并发处理任务时的稳定性、幂等性和回调可靠性。

## 运行

```bash
npm run test:load
```

## 原理

1. 启动 `test/fixtures/stub-server.js` 作为 fake 上游 API 和 fake VEVOR 页面。
2. 启动服务模式节点，配置 4 个并发通道。
3. 等待所有任务完成回调。
4. 断言：
   - 唯一回调数等于任务总数
   - 总回调数等于任务总数（无重复回调）
   - 成功回调数等于任务总数
   - 失败回调数为 0

## 配置

直接修改 `test/load/load-test.js` 顶部的常量：

- `taskCount`：任务数量（默认 12）
- `channels`：并发通道数（默认 4）
- 超时时间（默认 180 秒）

## 说明

- 该测试使用 Playwright 真实启动浏览器访问 stub 页面。
- 任务数量较大时会耗时较长（每个任务有约 10 秒内置等待）。
- 如需更快验证，可减少 `taskCount`。
