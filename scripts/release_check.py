#!/usr/bin/env python3
"""发布前检查（源码级）：不依赖 tarball，`npm publish` 之前必须过。

覆盖发布真正会翻车的三类事故：

1. **装不上** —— 语法错、manifest 字段缺失、`exports` 指向不存在的文件。
2. **行为退步** —— 运行时自测与扫描器自测。
3. **浏览器插件静默失效** —— `client.js` 违反 `dsh-client-modules` 的运行时契约
   （不注册、id 不匹配、顶层副作用、用了 ESM 语法）。这类错在服务端测试里
   完全看不到，装到用户机器上才发现插件根本不出现。

tarball 的实际内容由 `scripts/verify_tarball.py` 在 `npm pack` 之后检查——
那件事必须在打包之后做，放进这里会和打包互相依赖。

用法:
    python scripts/release_check.py

退出码:
    0  可以打包发布
    1  有阻断项
"""
import json
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL = os.path.join(BASE, "skills", "deepseek-code-supervisor")
ENV = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")

results = []


def step(label, argv):
    proc = subprocess.run(argv, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env=ENV)
    lines = ((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()
    results.append((label, proc.returncode == 0, lines[-1][:50] if lines else ""))


def assertion(label, body):
    try:
        body()
        results.append((label, True, ""))
    except AssertionError as error:
        results.append((label, False, str(error)[:60]))


with open(os.path.join(BASE, "package.json"), encoding="utf-8") as handle:
    pkg = json.load(handle)

# ── 1. 能加载 ────────────────────────────────────────────────────────────
MODULES = ["index.js", "guard.js", "verify.js", "retro.js", "shared.js", "client.js", "test.js"]
for name in MODULES:
    step(f"syntax {name}", ["node", "--check", os.path.join(BASE, name)])

# ── 2. 行为没退步 ────────────────────────────────────────────────────────
step("runtime suite", ["node", os.path.join(BASE, "test.js")])
step("scanner suite", [sys.executable, os.path.join(SKILL, "scripts", "test_scan_risks.py")])


def manifest_integrity():
    for field in ("name", "version", "description", "license", "type", "main",
                  "exports", "files", "dsh", "engines"):
        assert field in pkg, f"manifest 缺字段 {field}"
    for rel in pkg["files"]:
        assert os.path.exists(os.path.join(BASE, rel)), f"files[] 指向不存在的 {rel}"
    for sub, target in pkg["exports"].items():
        rel = target if isinstance(target, str) else target["default"]
        assert os.path.exists(os.path.join(BASE, rel.replace("./", ""))), f"exports {sub} -> {rel} 不存在"
    for rel in pkg["dsh"]["bundle"]["patch"]:
        assert os.path.exists(os.path.join(BASE, rel.replace("./", ""))), f"bundle patch {rel} 不存在"


def bundle_contract():
    """`client.js` 是浏览器 bundle：宿主按运行时契约加载，不检查构建来源。"""
    import re

    rel = pkg["exports"]["./client"]
    rel = rel if isinstance(rel, str) else rel["default"]
    with open(os.path.join(BASE, rel.replace("./", "")), encoding="utf-8") as handle:
        source = handle.read()
    assert "window.__ModuleLoader__.load({" in source, "bundle 从不注册（插件不会出现在界面上）"
    assert f"id: '{pkg['name']}'" in source, "bundle id 与包名不一致"
    assert "factory(require)" in source or "factory: (require)" in source, "bundle 没有 factory 形式"
    assert not any(line.strip().startswith(("import ", "export "))
                   for line in source.splitlines()), "bundle 用了 ESM 语法（它按传统脚本执行）"

    # 注册之前不得有可执行语句：脚本执行只应登记 factory，副作用留到 materialize。
    preamble = source[:source.index("window.__ModuleLoader__.load")]
    stripped = re.sub(r"/\*[\s\S]*?\*/", "", preamble)
    stripped = re.sub(r"//[^\n]*", "", stripped)
    assert stripped.strip() == "", "注册之前有可执行语句"


def market_meta():
    """市场列表读 locale/<lang>.json 的 meta；缺了就是一条没有标题的空白行。"""
    for lang in ("zh", "en"):
        path = os.path.join(BASE, "locale", f"{lang}.json")
        assert os.path.exists(path), f"缺 locale/{lang}.json（市场列表会空白）"
        with open(path, encoding="utf-8") as handle:
            meta = json.load(handle)["meta"]
        assert meta.get("title"), f"{lang} 没有标题"
        assert len(meta.get("description", "")) > 20, f"{lang} 描述太短"


def shipped_for_market():
    for required in ("client.js", "locale/", "LICENSE", "README.md", "presets/", "skills/"):
        assert required in pkg["files"], f"{required} 不在 files[] 里，不会随包发布"


def no_secrets():
    import re as _re
    patterns = [
        r"[A-Za-z]:[\\/]{1,2}Users[\\/]", r"/Users/[A-Za-z]", r"/home/[A-Za-z]",
        r"sk-[A-Za-z0-9]{20,}", r"ghp_[A-Za-z0-9]{20,}", r"AKIA[0-9A-Z]{16}",
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
    ]
    found = []
    for dirpath, dirnames, filenames in os.walk(BASE):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "dist")]
        for name in filenames:
            if not name.endswith((".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".py")):
                continue
            path = os.path.join(dirpath, name)
            try:
                text = open(path, encoding="utf-8").read()
            except (OSError, UnicodeDecodeError):
                continue
            for pattern in patterns:
                if _re.search(pattern, text):
                    found.append(os.path.relpath(path, BASE))
                    break
    assert not found, f"疑似泄漏: {', '.join(found[:3])}"


assertion("manifest integrity", manifest_integrity)
assertion("browser bundle contract", bundle_contract)
assertion("market metadata", market_meta)
assertion("shipped for market", shipped_for_market)
assertion("no machine paths or secrets", no_secrets)

print(f"{'发布前检查（源码级）':30s} 结果")
print("-" * 76)
bad = sum(1 for _, ok, _ in results if not ok)
for label, ok, tail in results:
    print(f"{label:30s} {'OK  ' if ok else 'FAIL'}  {tail}")

print()
print(f"{len(results) - bad}/{len(results)} 通过")
if bad == 0:
    print()
    print(f"可以打包：npm pack")
    print("打完再跑：python scripts/verify_tarball.py")
else:
    print()
    print("先修上面标 FAIL 的项。")
sys.exit(0 if bad == 0 else 1)
