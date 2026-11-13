#!/usr/bin/env python3
"""打包后检查：`npm pack` 之后跑，看 tarball 里实际有什么。

`release_check.py` 只看源码；这个脚本看的是**用户真正下载到的东西**。
两者分开是因为 tarball 只有在打包之后才存在，塞进前者会和打包互相依赖。

检查三件事：
  1. 市场渲染和运行必需的文件真的在 tarball 里（`files[]` 写对不等于真打进去了）。
  2. 没有混入不该发布的东西（缓存、`node_modules`、`.env`）。
  3. 解包后每个模块都能按 `exports` 加载起来——包括浏览器 bundle 的注册调用。

用法:
    npm pack
    python scripts/verify_tarball.py [--pack]

带 `--pack` 会先调用 `npm pack` 再检查。

退出码:
    0  可以发布
    1  有阻断项
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

with open(os.path.join(BASE, "package.json"), encoding="utf-8") as handle:
    pkgspec = json.load(handle)

NAME = pkgspec["name"]
VERSION = pkgspec["version"]

if "--pack" in sys.argv:
    proc = subprocess.run(["npm", "pack", "--silent"], cwd=BASE, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", shell=True)
    print("npm pack:", (proc.stdout or proc.stderr).strip()[:200])

candidates = glob.glob(os.path.join(BASE, f"{NAME}-{VERSION}.tgz"))
if not candidates:
    print(f"找不到 {NAME}-{VERSION}.tgz —— 先跑 `npm pack`（或加 --pack）。")
    sys.exit(1)
archive = candidates[0]

results = []


def check(label, ok, detail=""):
    results.append((label, ok, detail))


# ── 1. tarball 内容 ──────────────────────────────────────────────────────
REQUIRED = [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/cordis.patch.yml",
    "package/client.js",
    "package/index.js",
    "package/guard.js",
    "package/verify.js",
    "package/retro.js",
    "package/shared.js",
    "package/locale/zh.json",
    "package/locale/en.json",
    "package/presets/self-reflection.patch.yml",
    "package/skills/deepseek-code-supervisor/SKILL.md",
    "package/skills/deepseek-code-supervisor/scripts/scan_risks.py",
    "package/skills/deepseek-code-supervisor/scripts/rules.json",
]

with tarfile.open(archive, "r:gz") as tar:
    names = {n for n in tar.getnames() if not n.endswith("/")}
    missing = [rel for rel in REQUIRED if rel not in names]
    check("必需文件齐全", not missing, ", ".join(missing[:4]))

    # ── 2. 不混入不该发布的 ──────────────────────────────────────────────
    LEAK_TOKENS = ("__pycache__", ".pyc", "node_modules/", ".env", ".mutbak",
                   ".git/", "pnpm-lock.yaml")
    leaks = [n for n in names if any(token in n for token in LEAK_TOKENS)]
    check("无泄漏文件", not leaks, ", ".join(sorted(leaks)[:3]))

    check("体积合理", os.path.getsize(archive) < 2 * 1024 * 1024,
          f"{os.path.getsize(archive) / 1024:.0f} KB")

    # ── 3. 解包后能加载 ─────────────────────────────────────────────────
    root = tempfile.mkdtemp(prefix="tarball_")
    try:
        tar.extractall(root, filter="data")
        pkgdir = os.path.join(root, "package")
        manifest = json.load(open(os.path.join(pkgdir, "package.json"), encoding="utf-8"))

        missing_targets = []
        for sub, target in manifest["exports"].items():
            rel = target if isinstance(target, dict) else target
            rel = rel["default"] if isinstance(rel, dict) else rel
            if not os.path.exists(os.path.join(pkgdir, rel.replace("./", ""))):
                missing_targets.append(f"{sub} -> {rel}")
        check("exports 全部可解析", not missing_targets, ", ".join(missing_targets[:3]))

        # 用 node 走一遍 exports，浏览器 bundle 给 window 桩
        smoke = os.path.join(root, "smoke.mjs")
        with open(smoke, "w", encoding="utf-8") as handle:
            handle.write(f"""
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {{ pathToFileURL }} from 'node:url'
const ROOT = {json.dumps(pkgdir.replace(chr(92), '/'))}
const pkg = JSON.parse(fs.readFileSync(ROOT + '/package.json', 'utf8'))
let registered = null
globalThis.window = {{ __ModuleLoader__: {{ load({{ id }}) {{ registered = id }} }} }}
for (const [sub, target] of Object.entries(pkg.exports)) {{
  const rel = typeof target === 'string' ? target : target.default
  if (sub === './package.json') {{ JSON.parse(fs.readFileSync(ROOT + '/' + rel, 'utf8')); continue }}
  const mod = await import(pathToFileURL(ROOT + '/' + rel.replace(/^\\.\\//, '')).href)
  if (sub === './client') {{
    assert.equal(registered, pkg.name, 'client bundle did not register under the package name')
  }} else {{
    assert.ok(mod && typeof mod === 'object', 'no module object for ' + sub)
  }}
}}
console.log('SMOKE-OK')
""")
        proc = subprocess.run(["node", smoke], capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        ok = proc.returncode == 0 and "SMOKE-OK" in proc.stdout
        detail = "" if ok else (proc.stderr or proc.stdout).strip().splitlines()[-1][:80]
        check("解包后可加载（含浏览器 bundle）", ok, detail)
    finally:
        shutil.rmtree(root, ignore_errors=True)

print(f"{'打包后检查':30s} 结果")
print("-" * 74)
bad = sum(1 for _, ok, _ in results if not ok)
for label, ok, detail in results:
    print(f"{label:30s} {'OK  ' if ok else 'FAIL'}  {detail}")

print()
print(f"{os.path.basename(archive)}  {os.path.getsize(archive) / 1024:.0f} KB  {len(names)} 个文件")
print(f"{len(results) - bad}/{len(results)} 通过")
if bad == 0:
    print()
    print(f"可以发布：{NAME}@{VERSION}")
    print("下一步：npm publish")
else:
    print()
    print("先修上面标 FAIL 的项。")
sys.exit(0 if bad == 0 else 1)
