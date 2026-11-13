#!/usr/bin/env python3
"""扫描代码里的危险模式（第 3 项 / 第 6 项 的机械部分）。

用法:
    python scan_risks.py <目录或文件> [--block-only] [--json] [--max-size 2]

退出码:
    0  真的扫了文件，且没有 BLOCK 级问题（可能有 WARN）
    1  存在 BLOCK 级问题
    2  路径无效 / 规则表读不到
    3  一个能扫的文件都没有 —— 本门禁对这个项目不适用，**不算通过**
    4  有文件读不了（编码/权限/二进制）—— 覆盖不完整，**不算通过**

规则表在同目录 rules.json，可自行追加。规则表本身不参与扫描。
抑制单行告警：在那一行或上一行写 risk:ignore 并说明原因。
    except Exception:  # risk:ignore 进程退出前清理，下一行 re-raise

覆盖边界（写在这里，因为它决定了「绿色」到底证明了什么）:
  - 只扫 .py/.js/.mjs/.cjs/.ts/.tsx/.jsx/.sh/.bash 与常见配置后缀。
    Go / Java / C# / Rust / PowerShell 等语言**完全不扫**，那时退出码是 3。
  - **不查死代码**。规则表里没有一条死代码规则，第 2 项必须人工 grep。
  - 纯字符串匹配，不做 AST。它只能证明「某些字面形态不存在」。
"""

import argparse
import json
import os
import re
import sys

CODE_EXT = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".sh", ".bash"}
DATA_EXT = {".json", ".yml", ".yaml", ".toml", ".env", ".ini", ".conf"}
EXT_ALIAS = {"code": CODE_EXT, "data": DATA_EXT, "py": {".py"}, "sh": {".sh", ".bash"},
             "js": {".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"}}
SCAN_EXT = CODE_EXT | DATA_EXT

#: Dotfiles that carry secrets but have no ``splitext`` extension.
DOTFILE_NAMES = {".env", ".env.local", ".env.production", ".npmrc", ".netrc"}

SKIP_DIR = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", "env",
    "dist", "build", ".next", ".nuxt", "coverage", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", ".idea", ".vscode",
    "_archive", "vendor", "site-packages",
}

SKIP_FILE_SUFFIX = (".min.js", ".min.css", ".map", ".lock", "-lock.json", "-lock.yaml")
RULES_FILE = "rules.json"

BLOCK = "BLOCK"
WARN = "WARN"

EXIT_OK = 0
EXIT_BLOCK = 1
EXIT_CONFIG = 2
EXIT_NO_FILES = 3
EXIT_INCOMPLETE = 4


def load_rules(script_dir):
    path = os.path.join(script_dir, RULES_FILE)
    if not os.path.exists(path):
        sys.stderr.write("规则表缺失: %s\n" % path)
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        sys.stderr.write("规则表读不了: %s (%s)\n" % (path, e))
        return None

    compiled = []
    for r in raw.get("rules", []):
        try:
            exts = set()
            for a in r.get("exts", ["code"]):
                exts |= EXT_ALIAS.get(a, {a.lower()})
            compiled.append({
                "id": r["id"],
                "level": r.get("level", WARN).upper(),
                "name": r["name"],
                "exts": exts,
                "rx": re.compile(r["regex"], re.M),
                "why": r.get("why", ""),
            })
        except (KeyError, re.error) as e:
            sys.stderr.write("规则 %s 无效: %s\n" % (r.get("id", "?"), e))
            return None
    if not compiled:
        sys.stderr.write("规则表里没有可用规则\n")
        return None
    return compiled


def is_scannable_name(fn):
    """Whether one basename should be scanned (dotfiles have no extension)."""
    lower = fn.lower()
    if lower in DOTFILE_NAMES:
        return True
    return os.path.splitext(lower)[1] in SCAN_EXT


def rule_extension(path):
    """Extension used to match rules against one path.

    ``os.path.splitext('.env')`` returns ``''``, so a dotfile would silently
    match no rule and read as clean. Dotfiles are normalised to their own name
    as the extension (``.env``), which is what ``DATA_EXT`` already declares.
    """
    base = os.path.basename(path).lower()
    if base in DOTFILE_NAMES:
        return base
    return os.path.splitext(base)[1]


def iter_files(root, max_size_mb):
    """Yield scannable files plus the ones skipped for size or location."""
    if os.path.isfile(root):
        # A single explicit path skips the directory filters on purpose — the
        # caller named it — but still honours the size cap.
        try:
            if os.path.getsize(root) <= max_size_mb * 1024 * 1024:
                if os.path.basename(root).lower() != RULES_FILE:
                    yield root
        except OSError:
            pass
        return
    limit = max_size_mb * 1024 * 1024
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames
                             if d not in SKIP_DIR and not d.startswith("."))
        for fn in sorted(filenames):
            if fn.endswith(SKIP_FILE_SUFFIX) or fn.lower() == RULES_FILE:
                continue
            if not is_scannable_name(fn):
                continue
            path = os.path.join(dirpath, fn)
            try:
                if os.path.getsize(path) > limit:
                    continue
            except OSError:
                continue
            yield path


def read_text(path):
    """Read one file as UTF-8.

    Returns ``(text, problem)``: a file that decodes cleanly yields
    ``(text, None)``; one this tool cannot read yields ``("", reason)`` so the
    caller can report the gap instead of reporting a clean scan.

    ``errors="ignore"`` used to make every non-UTF-8 file look empty, which is
    indistinguishable from a file with no findings — the worst possible failure
    for a checker.
    """
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError as e:
        return "", "读不了 (%s)" % e.__class__.__name__
    if b"\x00" in raw:
        return "", "二进制或 UTF-16（含 NUL 字节）"
    try:
        return raw.decode("utf-8"), None
    except UnicodeDecodeError:
        for encoding in ("gbk", "gb18030"):
            try:
                return raw.decode(encoding), None
            except UnicodeDecodeError:
                continue
        return "", "非 UTF-8 且非 GBK"


def line_numbers(text):
    """Return a function mapping a character offset to its 1-based line.

    ``str.splitlines`` splits on U+2028, U+2029 and friends, so counting ``\\n``
    (and reporting that number) disagreed with the snippet taken from the same
    line index. Both sides now come from one model: physical lines end at `\\n`.
    """
    starts = [0]
    for index, char in enumerate(text):
        if char == "\n":
            starts.append(index + 1)

    def locate(offset):
        low, high = 0, len(starts) - 1
        while low < high:
            middle = (low + high + 1) // 2
            if starts[middle] <= offset:
                low = middle
            else:
                high = middle - 1
        return low + 1

    return locate


def scan(root, max_size_mb, rules):
    hits = []
    seen = set()
    files = 0
    unreadable = []
    for path in iter_files(root, max_size_mb):
        ext = rule_extension(path)
        text, problem = read_text(path)
        if problem is not None:
            unreadable.append((path, problem))
            continue
        files += 1
        if not text:
            continue
        lines = text.split("\n")
        locate = line_numbers(text)
        for rule in rules:
            if ext not in rule["exts"]:
                continue
            for m in rule["rx"].finditer(text):
                ln = locate(m.start())
                key = (rule["id"], path, ln)
                if key in seen:
                    continue
                here = lines[ln - 1] if 0 <= ln - 1 < len(lines) else ""
                above = lines[ln - 2] if ln >= 2 else ""
                if "risk:ignore" in here or "risk:ignore" in above:
                    continue
                seen.add(key)
                snippet = " ".join(here.strip().split())
                if len(snippet) > 160:
                    snippet = snippet[:157] + "..."
                hits.append({
                    "rule": rule["id"],
                    "level": rule["level"],
                    "name": rule["name"],
                    "file": path,
                    "line": ln,
                    "snippet": snippet,
                    "why": rule["why"],
                })
    hits.sort(key=lambda h: (h["level"] != BLOCK, h["file"], h["line"], h["rule"]))
    return files, hits, unreadable


def main():
    ap = argparse.ArgumentParser(description="扫描危险代码模式")
    ap.add_argument("path", help="要扫描的目录或文件")
    ap.add_argument("--block-only", action="store_true", help="只输出 BLOCK 级")
    ap.add_argument("--json", action="store_true", dest="as_json", help="输出 JSON")
    ap.add_argument("--max-size", type=int, default=2, help="单文件大小上限（MB），默认 2")
    args = ap.parse_args()

    root = os.path.abspath(args.path)
    if not os.path.exists(root):
        sys.stderr.write("路径不存在: %s\n" % root)
        return EXIT_CONFIG

    rules = load_rules(os.path.dirname(os.path.abspath(__file__)))
    if rules is None:
        return EXIT_CONFIG

    files, hits, unreadable = scan(root, args.max_size, rules)

    # Counts are taken BEFORE any display filter: `--block-only` used to hide
    # the WARN total and let a caller conclude there were none.
    n_block = sum(1 for h in hits if h["level"] == BLOCK)
    n_warn = sum(1 for h in hits if h["level"] == WARN)
    shown = [h for h in hits if h["level"] == BLOCK] if args.block_only else hits

    if files == 0 and unreadable:
        # Nothing could be read at all: report the coverage gap, not "not
        # applicable" — the project may well be in scope, the files just aren't
        # legible to this tool.
        code = EXIT_INCOMPLETE
    elif files == 0:
        code = EXIT_NO_FILES
    elif unreadable and n_block == 0:
        code = EXIT_INCOMPLETE
    else:
        code = EXIT_BLOCK if n_block else EXIT_OK

    if args.as_json:
        print(json.dumps({
            "root": root,
            "files_scanned": files,
            "block": n_block,
            "warn": n_warn,
            "exit": code,
            "unreadable": [{"file": p, "reason": r} for p, r in unreadable],
            "hits": shown,
        }, ensure_ascii=False, indent=2))
        return code

    def out(line=""):
        """Write one line, degrading gracefully on a console that cannot encode it."""
        try:
            print(line)
        except UnicodeEncodeError:
            print(line.encode("utf-8", "replace").decode("ascii", "backslashreplace"))

    out("扫描目录: %s" % root)
    out("文件数: %d   命中: %d   BLOCK: %d   WARN: %d" % (files, len(hits), n_block, n_warn))

    if unreadable:
        out("")
        out("读不了的文件（这些文件没有被检查，结论不覆盖它们）:")
        for path, reason in unreadable:
            out("      %s  <- %s" % (path, reason))

    if files == 0 and not unreadable:
        out("")
        out("没有任何可扫文件 —— 本门禁对这个项目不适用。")
        out("退出码 3 表示「没查」，不是「通过」。支持的后缀：%s"
            % " ".join(sorted(SCAN_EXT)))
        return code

    if files == 0:
        out("")
        out("一个文件都没读成 —— 覆盖为零，退出码 4。")
        return code

    if not shown:
        out("")
        out("没有命中。这不代表代码没问题 —— 形态扫描查不出逻辑错误，也不查死代码。")
        out("产物、可证伪、边界、泛化这几件事脚本查不了，按二轮检测的六项自己走。")
        return code

    current = None
    for h in shown:
        if h["rule"] != current:
            current = h["rule"]
            out("")
            out("[%s] %s %s" % (h["level"], h["rule"], h["name"]))
            out("      为什么: %s" % h["why"])
        out("      %s:%d" % (h["file"], h["line"]))
        if h["snippet"]:
            out("        | %s" % h["snippet"])

    out("")
    out("下一步:")
    if n_block:
        out("  1. 先修 %d 条 BLOCK，修完重跑本脚本。" % n_block)
        out("  2. 修不了的在那一行写 risk:ignore 和原因。")
        out("  3. WARN 可以留，但要在交付说明的「没验什么」里交代。")
    else:
        out("  没有 BLOCK。WARN 逐条判断：留就写理由，删就删干净。")

    return code


if __name__ == "__main__":
    sys.exit(main())
