#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = argv.slice(2);
  let nodes = 6;
  let output = path.resolve(__dirname, 'docker-compose.yml');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--nodes=')) {
      nodes = parseInt(arg.slice('--nodes='.length), 10);
    } else if (arg === '--nodes' && i + 1 < args.length) {
      nodes = parseInt(args[i + 1], 10);
      i++;
    } else if (arg.startsWith('--output=')) {
      output = path.resolve(__dirname, arg.slice('--output='.length));
    } else if (arg === '--output' && i + 1 < args.length) {
      output = path.resolve(__dirname, args[i + 1]);
      i++;
    }
  }

  if (Number.isNaN(nodes) || nodes < 1 || nodes > 20) {
    throw new Error('错误: --nodes 必须是 1-20 之间的整数');
  }

  return { nodes, output };
}

function baseServices() {
  return `services:
  crawlab:
    image: crawlabteam/crawlab:0.6.3
    container_name: crawlab
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - CRAWLAB_NODE_MASTER=y
      - CRAWLAB_MONGO_HOST=mongo
      - CRAWLAB_REDIS_HOST=redis
      - CRAWLAB_LOG_LEVEL=info
    volumes:
      - crawlab-data:/data
      - ./logs:/app/logs:ro
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
    networks:
      - crawler-net

  mongo:
    image: mongo:6.0.15
    container_name: crawlab-mongo
    restart: unless-stopped
    volumes:
      - mongo-data:/data/db
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    networks:
      - crawler-net

  redis:
    image: redis:7.2.4-alpine
    container_name: crawlab-redis
    restart: unless-stopped
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 5s
    networks:
      - crawler-net
`;
}

function crawlerService(index) {
  const nodeCode = `crawler-eu-${String(index).padStart(2, '0')}`;
  const healthPort = 3000 + index;
  return `  crawler-${index}:
    image: \${CRAWLER_IMAGE:?未设置 CRAWLER_IMAGE 环境变量}
    container_name: hs-sku-crawler-${index}
    restart: unless-stopped
    env_file: .env
    environment:
      - CRAWLER_MODE=service
      - CRAWLER_NODE_CODE=${nodeCode}
      - CRAWLER_HEALTH_PORT=${healthPort}
      - CRAWLER_CLIPROXY_SESSION_PREFIX=${nodeCode}
      - CRAWLER_HEADED_FALLBACK=false
    ports:
      - "127.0.0.1:${healthPort}:${healthPort}"
    volumes:
      - ./logs:/app/logs
      - ./output/${nodeCode}:/app/output
      - ./images/${nodeCode}:/app/images
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 800M
        reservations:
          cpus: '0.2'
          memory: 400M
    depends_on:
      redis:
        condition: service_healthy
    networks:
      - crawler-net
`;
}

function footer() {
  return `volumes:
  crawlab-data:
  mongo-data:
  redis-data:

networks:
  crawler-net:
    driver: bridge
`;
}

function generate({ nodes }) {
  const parts = [baseServices()];
  for (let i = 1; i <= nodes; i++) {
    parts.push(crawlerService(i));
  }
  parts.push(footer());
  return parts.join('\n');
}

function main(argv) {
  try {
    const { nodes, output } = parseArgs(argv);
    const content = generate({ nodes });
    fs.writeFileSync(output, content, 'utf-8');
    console.log(`已生成 ${nodes} 个 crawler 节点: ${output}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { parseArgs, generate, crawlerService };
