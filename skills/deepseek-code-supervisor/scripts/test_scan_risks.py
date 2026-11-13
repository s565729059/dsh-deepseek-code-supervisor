#!/usr/bin/env python3
"""scan_risks.py 的自检测试。

第 1.3 条说的是「写检查代码前，先给检查代码做检查」。这个脚本就是那件事：
它不检查你的项目，它检查 `scan_risks.py` 本身是否在骗人。

用法:
    python test_scan_risks.py

退出码:
    0  全部通过
    1  有失败（每条会打印期望值与实际值）

覆盖的是真实踩过的坑，不是设想的坑：
  - 非 UTF-8 文件曾静默「零命中 + 退出码 0」
  - 只认 4 门语言，其他语言曾静默「零文件 + 退出码 0」
  - `--block-only` 曾把 WARN 统计过滤掉，报「没有 WARN」
  - `.env` 因 splitext 返回空扩展名，曾永远进不了规则匹配
  - CRLF 文件里「裸 except」曾整条失效
  - U+2028 会让行号与实际语句错位
  - 抛出 UnicodeEncodeError 时退出码是 1，与「有 BLOCK」无法区分
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "scan_risks.py")
RULES_FILE = os.path.join(HERE, "rules.json")


def run(*argv):
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    proc = subprocess.run(
        [sys.executable, SCRIPT, *argv],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main():
    try:
        rules = {r["id"]: r for r in json.load(open(RULES_FILE, encoding="utf-8"))["rules"]}
    except (OSError, json.JSONDecodeError) as exc:
        print("规则表读不了: %s" % exc)
        return 1

    failures = []
    checked = 0

    def expect(label, actual, wanted):
        nonlocal checked
        checked += 1
        if actual != wanted:
            failures.append("%s: 期望 %r，实际 %r" % (label, wanted, actual))

    def expect_hit(label, rule_id, sample, wanted):
        """Rule-level: does one regex fire on one sample?"""
        nonlocal checked
        checked += 1
        got = re.search(rules[rule_id]["regex"], sample, re.M) is not None
        if got != wanted:
            failures.append("%s: 规则 %s 期望命中=%s，实际=%s" % (label, rule_id, wanted, got))

    # ── 规则级：真实漏报与误报 ──────────────────────────────────────
    expect_hit("裸 except（LF）", "R03", "    except:\n        pass\n", True)
    expect_hit("裸 except（CRLF）", "R03", "    except:\r\n        pass\r\n", True)
    expect_hit("带类型的 except 不算裸", "R03", "    except Exception:\r\n        pass\r\n", False)
    expect_hit("rm -rf 空值守卫不该报", "R06", 'rm -rf "${DIR:?}"\n', False)
    expect_hit("rm -rf $DIR 该报", "R06", "rm -rf $DIR\n", True)
    expect_hit("rm --recursive --force 该报", "R06", "rm --recursive --force $D\n", True)
    expect_hit("Remove-Item -Recurse -Force 该报", "R06", "Remove-Item C:\\x -Recurse -Force\n", True)
    expect_hit("privateKey 该报", "R05", 'privateKey = "abcdefghijklmnop1234567890"\n', True)
    expect_hit("无引号 DB_PASSWORD 该报", "R05", "DB_PASSWORD=abcdefghijklmnop1234567890\n", True)
    expect_hit("短值不算密钥", "R05", "token = 'abc'\n", False)
    expect_hit("assertEqual 空列表该报", "R07", "self.assertEqual([], [])\n", True)
    expect_hit("promise.catch 不该报", "R01", "promise.catch(function () {})\n", False)
    expect_hit("小写盘符路径该报", "R04", "p = 'c:\\users\\bob\\x.py'\n", True)

    # ── 脚本级：退出码与覆盖 ────────────────────────────────────────
    root = tempfile.mkdtemp(prefix="selfcheck_")
    try:
        def write(rel, data, encoding="utf-8"):
            path = os.path.join(root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as handle:
                handle.write(data if isinstance(data, bytes) else data.encode(encoding))

        write("clean/a.js", "const x = 1\nfunction f() { return x }\n")
        expect("干净文件退出码", run(os.path.join(root, "clean"))[0], 0)

        write("danger/a.js", "try { g() } catch (e) {}\n")
        expect("有 BLOCK 退出码", run(os.path.join(root, "danger"))[0], 1)

        write("go/main.go", "package main\n")
        expect("不受支持的语言退出码", run(os.path.join(root, "go"))[0], 3)

        write("u16/wide.py", "except:\n    pass\n".encode("utf-16-le"))
        expect("读不了的文件退出码", run(os.path.join(root, "u16"))[0], 4)

        write("gbk/g.py", "try:\n    g()\nexcept Exception:\n    pass\n", encoding="gbk")
        expect("GBK 文件仍能检出", run(os.path.join(root, "gbk"))[0], 1)

        write("env/.env", "API_KEY=abcdefghijklmnopqrstu\n")
        expect(".env 能被扫", run(os.path.join(root, "env"))[0], 1)

        write("warn/a.js", "// TODO later\n")
        code, out = run(os.path.join(root, "warn"), "--block-only")
        expect("--block-only 不吞 WARN 计数", "WARN: 1" in out, True)

        write("emoji/e.py", "# 🀄\nexcept:\n    pass\n")
        expect("命中行含 emoji 不崩", run(os.path.join(root, "emoji"))[0], 1)

        write("sep/l.js", "const a = 1\nconst b = 2\n/* x\u2028y */\ntry { g() } catch (e) {}\n")
        code, out = run(os.path.join(root, "sep"))
        line = next((ln.strip() for ln in out.splitlines() if "l.js:" in ln), "")
        expect("U+2028 后行号仍是 4", line.endswith(":4"), True)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    if failures:
        print("自检失败 %d 项：" % len(failures))
        for item in failures:
            print("  - " + item)
        return 1
    print("scan_risks.py 自检通过：%d 项" % checked)
    return 0


if __name__ == "__main__":
    sys.exit(main())
