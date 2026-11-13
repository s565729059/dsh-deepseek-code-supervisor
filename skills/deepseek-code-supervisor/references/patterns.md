# 危险代码模式清单

可直接 grep。每条给出「搜什么 / 为什么危险 / 例外」。

扫描脚本 `scripts/scan_risks.py` 覆盖了前 10 条，下面是全量人工版。

---

## BLOCK 级（发现就要改）

### 1. 空 catch / 裸 except

```bash
grep -rn "catch\s*(\s*[A-Za-z_$]*\s*)\s*{\s*}" --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx" .
grep -rn "catch\s*{\s*}" --include="*.js" --include="*.ts" .
grep -rn -A1 "except\s*\(\s*Exception\s*\)\s*:\|except\s*:" --include="*.py" . | grep -E "^\S+[-:][0-9]+[-:]\s*pass\s*$"
```

危险：错误消失。功能只是"有点不对"，日志干净，排查看不出线索。
例外：进程退出前的清理，且下一行有 `return`/`raise`。

### 2. 疑似密钥

```bash
grep -rniE "(api[_-]?key|secret|token|password)\s*[:=]\s*['\"][^'\"]{8,}" --include="*.py" --include="*.js" --include="*.ts" --include="*.json" --include="*.yml" --include="*.yaml" .
grep -rn "sk-[A-Za-z0-9]\{20,\}\|ghp_[A-Za-z0-9]\{20,\}\|AKIA[0-9A-Z]\{16\}" .
```

危险：进了 git 就等于公开。静态构建还会把它复制进产物。
例外：`.env.example` 里的占位符（`sk-xxxx`）。

### 3. 硬编码本机路径

```bash
grep -rnE "C:\\\\\\\\Users|C:/Users|/Users/[A-Za-z]|/home/[A-Za-z]" --include="*.py" --include="*.js" --include="*.ts" --include="*.md" --include="*.json" .
```

危险：换台机器就跑不了；发布包里泄露用户名。
例外：文档里的示例，且明确标了"示例"。

### 4. 危险的递归删除

```bash
grep -rnE "rm\s+-rf\s+[\\\$\{A-Za-z_]" --include="*.sh" --include="*.py" --include="*.js" .
grep -rn "shutil.rmtree" --include="*.py" .
grep -rn "del /[Ss] /[Qq]" .
```

危险：变量为空时 `rm -rf $DIR` 会变成 `rm -rf`。
例外：`rm -rf "$DIR"` 且上一行有 `[ -n "$DIR" ] || exit 1` 守卫。

### 5. 恒真断言 / 空跑测试

```bash
grep -rn "assert.*range(1,\s*1)\|assertEqual(.*\[\],\s*\[\])\|expect(true)\|assertTrue(true)" .
grep -rn "if nums == range" .
```

危险：测试绿得毫无意义。

---

## WARN 级（要解释，不能默默留着）

### 6. TODO / FIXME / 半成品标记

```bash
grep -rn "TODO\|FIXME\|XXX\|HACK\|暂时\|先这样\|以后再说\|待补" --include="*.py" --include="*.js" --include="*.ts" --include="*.md" .
```

危险：当作交付内容一起交出去。
处理：做不了就明说，别混在成品里。

### 7. 调试输出残留

```bash
grep -rn "console\.log\|print(\"debug\|fmt\.Println" --include="*.js" --include="*.ts" --include="*.py" . | grep -v "test\|spec\|__main__"
```

危险：生产日志被淹没；前端把内部结构打到控制台。

### 8. 静默跳过

```bash
grep -rn -B2 "^\s*continue;\?\s*$" --include="*.js" --include="*.py" .
```

危险：每条 `continue` 都是"这里的数据我不要了"。没有注释说明就是 B-1 那类事故。

### 9. 吞掉 stderr / 退出码

```bash
grep -rn "2>/dev/null\|2>&1\s*$\||\s*tail\||\s*head" --include="*.sh" --include="*.md" .
```

危险：故障看起来像成功。
处理：要验退出码就重定向到文件。

### 10. 魔法数字

```bash
grep -rnE "(timeout|limit|max|size|count)\s*[:=]\s*[0-9]{3,}" --include="*.py" --include="*.js" --include="*.ts" .
```

危险：`timeout: 240000` 这种数字没法判断对错。
处理：至少写一行注释说明这个数是怎么来的。

---

## 语言/框架专项

### JS/TS

| 模式 | 危险 |
|---|---|
| `Number(x)` 直接用于外部输入 | `null` → 0 |
| `== null` 之外的双等号 | `"0" == false` |
| `JSON.parse` 无 try/catch | 一个坏字符整段崩 |
| `for...in` 遍历数组 | 会遍历原型链 |
| `await` 在 `forEach` 里 | 不等待，顺序乱 |
| `new Date(str)` | 各浏览器解析不一致 |

### Python

| 模式 | 危险 |
|---|---|
| `except Exception:` 不带 `as e` | 看不到错误 |
| 可变默认参数 `def f(a=[])` | 跨调用共享 |
| `open()` 不用 `with` | 异常时不关闭 |
| `json.loads` 裸调用 | 坏输入直接 traceback |
| `os.path.join` 混用字符串拼接 | Windows 路径错 |
| `subprocess.run` 不带 `check=True` | 失败静默 |

### 数据处理

| 模式 | 危险 |
|---|---|
| 按固定步长跳行 | 人工维护的表步长不可信，遇到异常行就整列错位 |
| 假设列位置固定 | 多加一列全错 |
| 用 `split('\n')[0]` 取姓名 | 带后缀的正常，但空值会 IndexError |
| 直接 `int(值)` | `'43.5/70'`、`'80+'`、`'有进步'` 都会炸 |

---

## 项目发布前额外三查

```bash
# 1. 本机路径 / 用户名
grep -rnE "C:[\\\\/]+Users[\\\\/]+[A-Za-z]|/Users/[A-Za-z]|/home/[A-Za-z]" <包目录>
# 2. 真实姓名 / 学校 / 公司
grep -rn "<姓名>\|<学校>\|<公司>" <包目录>
# 3. 构建产物里有没有不该有的
ls -la dist/ && find dist -name "*.pem" -o -name "*.key" -o -name ".env*" -o -name "*.sqlite"
```

三项命中数都必须是 0。
