# Multi-machine Deployment Test

多机部署测试：验证多个爬虫节点协同工作时任务不被重复消费、全部成功回调。

## 本地模拟（Docker Compose）

需要安装 Docker 和 docker-compose。

```bash
npm run test:deployment:local
```

该命令会：

1. 启动 stub server 容器。
2. 启动 3 个 crawler 节点容器，每个节点 1 个通道。
3. 等待所有任务处理完毕。
4. 验证无重复回调、全部成功。
5. 清理容器。

## 真实多机部署

### 1. 准备 stub server

在可访问的机器上启动 stub server：

```bash
node test/fixtures/stub-server.js --port 8080 --host 0.0.0.0 --task-count 100
```

### 2. 环境检查

```bash
STUB_SERVER_URL=http://your-stub-server:8080 ./test/deployment/multi-machine.sh check
```

### 3. 查看启动命令

```bash
STUB_SERVER_URL=http://your-stub-server:8080 MACHINES="crawler-01 crawler-02 crawler-03" ./test/deployment/multi-machine.sh commands
```

### 4. 在每台机器上部署代码并启动

方式 A：手动执行 `commands` 输出的命令。

方式 B：通过 SSH 批量启动（需配置 SSH 密钥或 agent）：

```bash
export STUB_SERVER_URL=http://your-stub-server:8080
export MACHINES="crawler-01 crawler-02 crawler-03"
export SSH_USER=root
export REMOTE_DIR=/opt/vevor-crawler
./test/deployment/multi-machine.sh start
```

### 5. 验证结果

```bash
STUB_SERVER_URL=http://your-stub-server:8080 ./test/deployment/multi-machine.sh validate
```

### 6. 停止节点

```bash
MACHINES="crawler-01 crawler-02 crawler-03" ./test/deployment/multi-machine.sh stop
```

### 7. 收集日志

```bash
MACHINES="crawler-01 crawler-02 crawler-03" ./test/deployment/multi-machine.sh logs
```

## 代理配置

如需为每个节点配置代理：

```bash
export CRAWLER_PROXY=http://proxy:8080
./test/deployment/multi-machine.sh start
```

