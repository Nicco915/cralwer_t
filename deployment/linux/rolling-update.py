#!/usr/bin/env python3
"""VPS 滚动更新脚本（生产权威版本，VPS 上位于 /tmp/rolling-update.py）。

用法：python3 rolling-update.py vX.Y.Z

行为：
1. docker pull 目标镜像
2. 逐台（hs-sku-crawler-1..8）：stop -> rename -bak -> 按原容器 inspect
   配置重建（env/mount/network/端口/日志驱动全量保留，--hostname 显式重建，
   ENV_OVERRIDES 中声明的 env 用新值替换快照）
   -> 等 /health 返回 200（最长 150s）
3. 健康则删 -bak 继续下一台；不健康则删新容器、恢复 -bak 并整体中止

⚠️ --hostname crawler-N 必须显式重建：Blackbox 探活走 Docker DNS
（http://crawler-N:300N/health），漏掉 hostname 会导致 Grafana 探活静默掉线。
"""
import json
import subprocess
import sys
import time
import urllib.request

TAG = sys.argv[1] if len(sys.argv) > 1 else "v1.3.3"
IMAGE = "ghcr.io/nicco915/cralwer_t:%s" % TAG
NODES = range(1, 9)
HEALTH_TIMEOUT = 150

# env 覆盖：重建容器时用这里的值替换 inspect 快照中的同名变量。
# 滚动更新默认冻结旧容器 env，改配置只能在这里显式声明（改动会随
# 新容器快照延续到后续滚动更新）。不需要改 env 时保持为空 dict。
ENV_OVERRIDES = {
    "CLIPROXY_STICKY_MINUTES": "10",  # v1.3.3: sticky 5 -> 10 分钟
    # 2026-07-20 事故：旧入口 us2.cliproxy.io 出口间歇挂起（CONNECT 后不响应）、
    # 延迟 2-7s；官方推荐入口 us.arxlabs.io 实测 8 个 ASN 全部命中且 <1.5s。
    "CLIPROXY_HOST": "us.arxlabs.io",
}

# 每节点独立的 cliproxy session prefix（v1.3.4 修复）：
# cliproxy 以 sid 第一个 "-" 前的字符串作为 session key。
# 旧格式 "crawler-01-ch1-<nonce>" 第一段恒为 "crawler"，
# 导致所有容器共享同一 IP。改为 "v01".."v08"（无 "-"）后，
# 每个容器第一段唯一，获得独立 IP。
NODE_SESSION_PREFIX = {i: "v%02d" % i for i in NODES}

# 每节点独立的 cliproxy ASN（v1.3.5）：8 容器原先共用 DE/AS12897 小池，
# 池子侧偶发给不同 session 分同一出口 IP（v01/v02 撞 94.46.92.173）。
# 改为一容器一 ASN：不同 AS 的 IP 前缀天然不相交，跨爬虫撞 IP 在结构上不可能。
# 以下 8 个 ASN 已在 VPS 实测（2026-07-15）cliproxy 有真实库存：
#   AS3320=Telekom AS3209=Vodafone AS6805=O2 AS8881=1&1
#   AS9145=EWE-Tel AS13045=htp AS8767=M-net AS12897=ENTEGA（保留现池）
# 注意：cliproxy 对无库存的 ASN 不报错、静默回落到其他池
# （如 AS31334->AS3209、AS29562->AS3320），换 ASN 后必须验证出口 org 与目标一致。
NODE_ASN = {
    1: "AS3320",
    2: "AS3209",
    3: "AS6805",
    4: "AS8881",
    5: "AS9145",
    6: "AS13045",
    7: "AS8767",
    8: "AS12897",
}


def sh(cmd, check=True):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError("cmd failed: %s\n%s" % (" ".join(cmd), r.stderr.strip()))
    return r


def wait_healthy(port, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:%s/health" % port, timeout=5
            ) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(3)
    return False


def build_run_args(name, idx, spec):
    cfg, host = spec["Config"], spec["HostConfig"]
    args = [
        "docker", "run", "-d",
        "--name", name,
        # Blackbox 探活用 http://crawler-N:300N 走 Docker DNS，必须显式 hostname
        "--hostname", "crawler-%d" % idx,
        "--network", host["NetworkMode"],
        "--restart", host["RestartPolicy"]["Name"],
        "--log-driver", host["LogConfig"]["Type"],
    ]
    for k, v in (host["LogConfig"].get("Config") or {}).items():
        args += ["--log-opt", "%s=%s" % (k, v)]
    seen = {}
    for e in cfg["Env"]:
        key = e.split("=", 1)[0]
        seen[key] = e
    for key, val in ENV_OVERRIDES.items():
        new = "%s=%s" % (key, val)
        if seen.get(key) != new:
            print("[roll] %s: env override %s -> %s" % (name, key, val), flush=True)
        seen[key] = new
    # 每节点独立的 cliproxy session prefix（v1.3.4 修复）
    # 注意：代码里 CRAWLER_CLIPROXY_SESSION_PREFIX 优先级高于 CLIPROXY_SESSION_PREFIX
    # （src/cli.js envMap 中前者先出现，且只在 config 值为 undefined 时写入），
    # 所以两个 env 都必须覆盖，否则旧值仍生效。
    node_prefix = NODE_SESSION_PREFIX[idx]
    for key in ("CRAWLER_CLIPROXY_SESSION_PREFIX", "CLIPROXY_SESSION_PREFIX"):
        new_val = "%s=%s" % (key, node_prefix)
        if seen.get(key) != new_val:
            print("[roll] %s: env override %s -> %s" % (name, key, node_prefix), flush=True)
        seen[key] = new_val
    # 每节点独立的 cliproxy ASN（v1.3.5）：一容器一 ASN，跨爬虫 IP 结构性不相交
    node_asn = NODE_ASN[idx]
    new_val = "CLIPROXY_ASN=%s" % node_asn
    if seen.get("CLIPROXY_ASN") != new_val:
        print("[roll] %s: env override CLIPROXY_ASN -> %s" % (name, node_asn), flush=True)
    seen["CLIPROXY_ASN"] = new_val
    for e in seen.values():
        args += ["-e", e]
    for b in host["Binds"] or []:
        args += ["-v", b]
    for cport, bindings in (host.get("PortBindings") or {}).items():
        for b in bindings:
            args += ["-p", "%s:%s:%s" % (b["HostIp"], b["HostPort"], cport)]
    args.append(IMAGE)
    return args


def main():
    print("[roll] target image: %s" % IMAGE, flush=True)
    sh(["docker", "pull", IMAGE])

    for i in NODES:
        name = "hs-sku-crawler-%d" % i
        bak = name + "-bak"
        spec = json.loads(sh(["docker", "inspect", name]).stdout)[0]
        port = next(iter(spec["HostConfig"]["PortBindings"].values()))[0]["HostPort"]
        print("[roll] %s: stop+rename -> %s" % (name, bak), flush=True)
        sh(["docker", "stop", name])
        sh(["docker", "rename", name, bak])
        try:
            sh(build_run_args(name, i, spec))
        except Exception as e:
            print("[roll] %s: run failed: %s; restoring backup" % (name, e), flush=True)
            sh(["docker", "rename", bak, name])
            sh(["docker", "start", name])
            sys.exit(1)
        print("[roll] %s: waiting /health on 127.0.0.1:%s ..." % (name, port), flush=True)
        if wait_healthy(port, HEALTH_TIMEOUT):
            sh(["docker", "rm", "-f", bak])
            print("[roll] %s: OK (healthy), backup removed" % name, flush=True)
        else:
            logs = sh(["docker", "logs", "--tail", "20", name], check=False)
            print("[roll] %s: NOT healthy in %ds, rolling back" % (name, HEALTH_TIMEOUT), flush=True)
            print(logs.stdout + logs.stderr, flush=True)
            sh(["docker", "rm", "-f", name], check=False)
            sh(["docker", "rename", bak, name])
            sh(["docker", "start", name])
            sys.exit(1)

    print("[roll] all 8 containers updated", flush=True)


if __name__ == "__main__":
    main()
