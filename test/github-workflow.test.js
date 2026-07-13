const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('.github/workflows/deploy-vps.yml', () => {
  const workflowPath = path.resolve(__dirname, '../.github/workflows/deploy-vps.yml');
  const read = () => fs.readFileSync(workflowPath, 'utf-8').replace(/\r\n/g, '\n');

  it('exists', () => {
    assert.ok(fs.existsSync(workflowPath), 'workflow should exist');
  });

  it('triggers on tag push', () => {
    assert.ok(read().includes("tags:\n      - 'v*'"), 'should trigger on v* tags');
  });

  it('builds and pushes image to ghcr', () => {
    const content = read();
    assert.ok(content.includes('ghcr.io/${{ steps.repo.outputs.lower }}'), 'should use ghcr');
    assert.ok(content.includes('docker/build-push-action'), 'should build and push');
  });

  it('declares workflow permissions', () => {
    assert.ok(read().includes('permissions:'), 'should declare permissions');
  });

  // 生产 8 个容器是独立 docker run 管理（见 VPS /tmp/rolling-update.py），
  // compose 风格的 deploy job 会误建一个与 hs-sku-crawler-1 身份重复的容器，
  // 因此 workflow 只负责构建镜像，部署由滚动更新脚本完成。
  it('is build-only: has no SSH deploy job', () => {
    const content = read();
    assert.ok(!content.includes('appleboy/ssh-action'), 'should not deploy via ssh action');
    assert.ok(!content.includes('secrets.VPS_HOST'), 'should not use VPS_HOST secret');
    assert.ok(!content.includes('secrets.VPS_SSH_KEY'), 'should not use VPS_SSH_KEY secret');
    assert.ok(!content.includes('update.sh'), 'should not invoke update.sh on VPS');
  });
});
