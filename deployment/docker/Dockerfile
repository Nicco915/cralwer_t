FROM node:20-slim

# 安装系统依赖与 Chromium 所需库
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates procps \
    libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libgbm1 libasound2 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgtk-3-0 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# 创建非 root 用户，uid/gid 固定 1000，与宿主机挂载目录属主对齐
# （基础镜像自带 node 用户占用 1000，先删除）
RUN userdel node 2>/dev/null || true \
    && groupdel node 2>/dev/null || true \
    && groupadd -g 1000 crawler \
    && useradd -u 1000 -g crawler -d /app -M crawler

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# 以 root 安装 Playwright Chromium 到项目目录
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright
RUN npx playwright install chromium
RUN chown -R crawler:crawler /app

USER crawler

COPY --chown=crawler:crawler . .

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/app/ms-playwright

CMD ["node", "bin/run.js"]
