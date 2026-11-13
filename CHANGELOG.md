# 变更记录

本文件记录每个版本的对外可见变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-11-13

首个对外发布版本。以下按「相对开发期内部版本的净结果」记录，不是逐次提交的流水账。

### 新增

- **目标分类 `shared.js`**：把「什么算代码」拆成 `code` / `config` / `doc` 三档，门禁与注入共用同一份判定，消除此前两处硬编码表漂移的风险。
- **依赖与配置文件纳入门禁**：`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、CI 的 yml、`.env` 现在都要求先加载检测流程。此前它们被放行，而 skill 自己把「加依赖改配置」列为大改动。
- **shell 写入门禁**：`bash` / `pwsh` 的明显写入形态（重定向、`Set-Content`、`Out-File`、`sed -i`、`tee`、`git apply`、`prettier --write`）会要求先加载 skill。这是提高绕过成本，不是封死。
- **`locale/` 市场元数据**：中英双语 `meta.title` 与 `meta.description`，供插件市场展示。
- **`LICENSE`**（MIT）、**`.gitignore`**、**`CHANGELOG.md`**。
- **自检套件**：`node test.js`（27 项）与 `python skills/.../test_scan_risks.py`（22 项）。

### 修复

- **被拒绝的写入不再注入「刚改了代码」**。此前门禁拒绝、以及 `old_string` 未匹配的失败 edit，都会触发 701 字的「刚改了代码」提示，诱导模型去报告一次并不存在的改动。
- **同一轮内注入去重**。首条为完整五项，后续降为一行；此前每次编辑都贴全文，10 次编辑累计约 7000 字常驻上下文。
- **`verify.js` 在缺少 `agent.session` 时抛错**。`Agent` 接口只声明 `id`，`WeakMap.set(undefined, …)` 会抛 `Invalid value used as weak map key`，导致整条 `post-execute` 瀑布流中断、该次编辑之后的所有注入丢失。改用 agent 本身作键，并以 `agent/status` 的 `idle` 作为回合边界。
- **`2> file` 一类重定向完全漏检**。注释声称支持，正则实际一个都匹配不上。
- **`retro.js` 读取失败会永久放弃本会话注入**。此前先置位标记再读文件；现在区分「文件不存在」（结案）与「读取失败」（下一步重试）。
- **`retro.js` 截断无标记**。超预算时从中间切断且不留痕迹，现在追加「…仅保留最近部分」。
- **`retro.js` 只读尾部**。实测大文件不再整份读入 pre-step 热路径。
- **`scan_risks.py` 的 7 条假绿路径**：
  - 非 UTF-8 文件静默「零命中 + 退出码 0」
  - 只认 4 门语言，其他语言静默全绿
  - `.env` 因 `splitext` 返回空扩展名，永远进不了规则匹配
  - `--block-only` 把 WARN 统计过滤掉
  - 输出编码崩溃时退出码与「有 BLOCK」同为 1
  - U+2028 导致行号错位
  - 死代码零覆盖
  退出码改为 `0` 通过 / `1` 有 BLOCK / `2` 配置故障 / `3` 无适用文件 / `4` 覆盖不完整，只有 `0` 算通过。
- **规则表 5 处漏报/误报**：CRLF 下「裸 except」失效、`privateKey`/无引号密钥漏报、`rm --recursive --force` 漏报、`assertEqual([], [])` 漏报、`promise.catch(fn)` 误报。
- **9 个死导出**：只在本文件内部使用的符号不再对外 `export`。

### 变更

- **弹窗**：古文两句合并为一行（此前被拆成两个 `display: block` 的 `span`，必然折行）；卡片宽度 360 → 480px；正文字号 14 → 16px；古文与内边距改为 `clamp()` 随视口缩放，320–1280px 全区间单行不折行。
- **`SKILL.md` 瘦身**：发布面安全三查改为指向 `references/scenarios.md`（原本就在那里，重复抄写无新增信息）；自检六项里新加的论述改为指向 `references/checks.md` 取证 8。
- **口径统一**：拆批阈值 3 → 2 个文件（与大改动判据一致）；报告节数统一为「结论 + 六节」；轮次计数统一为 L3 轮数；补上「同一问题最多修 2 轮」的收敛阈值。
- **补覆盖空白**：幂等方向判断、落盘后重读复检、字符数 vs 字节数、删除功能的爆炸半径、外部观测，进入 `references/checks.md` 取证 8。
- **`client.js` 错误处理**：切换失败时把原因显示在按钮上，不再静默；重复点击用 `useRef` 同步拦截。

### 明确不做

- **终检子智能体不加门禁**：它只读不写（`references/reviewer-brief.md` 三处写明「只出结论，不改代码」），不需要门禁，需要的是明确的只读授权。
- **不设字数预算门禁**：由人判断内容是否需要，不用脚本卡字数。
