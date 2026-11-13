# 铁尺 · deepseek-code-supervisor

「反思模式」——一个**硬性模式**，不是可选开关：会话一旦以它开启，整个会话都强制走二轮检测，代码改动后必须自检、必须判断要不要终检。

> 仓库：<https://github.com/s565729059/dsh-deepseek-code-supervisor>

## 安装

```bash
dsh plugin --profile <profile> add dsh-deepseek-code-supervisor
```

或从本目录安装：

```bash
dsh plugin --profile <profile> add <本目录绝对路径>
```

装好后 **新建任务**时在模式选择里选「反思模式」，或点输入框右侧、模型选择旁边的「反思模式」按钮。会话一旦开始，模式就不再可切（宿主 `agent-preset/locked`），按钮也会消失——这是刻意设计。

## ⚠️ 改过 `client.js` 之后必须重启

`client.js` 是浏览器侧 bundle，宿主在**启动时**把它读进内存，之后不再读文件（`dsh-client-modules` 没有文件监视器，只有插件重新加载才会重新读）。

所以：**改完 `client.js`，必须重启 DeepSeek Harness，或让插件重新加载，浏览器里才会变。** 只刷新页面不够——宿主发给页面的还是启动时那份字节。

宿主用 `(mtimeMs, ctimeMs, size)` 三元组给 bundle 算修订号，任一变化就换新的 `?rev=` URL，所以重启后**不会**读到浏览器旧缓存。问题只在于「宿主什么时候重新读文件」，不在浏览器。

服务端模块（`guard.js` / `verify.js` / `retro.js` / `shared.js` / `index.js`）不受此限，它们随插件重载自然生效。

## 六个部分

| 部分 | 文件 | 作用 |
|---|---|---|
| skill | `index.js` + `skills/` | `deepseek-code-supervisor` 进全局 skill 目录，按需加载，零常驻成本 |
| 模式 | `presets/self-reflection.patch.yml` | preset `self-reflection`：硬性人设 + 标准工具集 + 三道约束 |
| 分类 | `shared.js` | `code` / `config` / `doc` 三档判定，门禁与注入共用一份，避免两处漂移 |
| 门禁 | `guard.js` | 没加载过 skill 的 agent，写 `code`/`config` 一律被拒；shell 的明显写入形态也拦 |
| 验收注入 | `verify.js` | 成功落盘后注入本轮必做项（失败调用不注入、同轮去重）；子智能体返回后注入结论处理规则 |
| 复盘注入 | `retro.js` | 会话第一步读 cwd 下 `.workbuddy/复盘.md`，注入最近 5 条 |
| 按钮 | `client.js` | 新会话输入框右侧的开关 + 开启提示卡片 |

## 硬性要求落在哪

不是靠一句话，而是三道机制叠起来：

1. **人设**（每轮常驻，实测约 950 token）：10 条硬性流程 —— 验收判据、复现优先、小步 diff 自检、**自检六项**、两个取证、证据或未验、对抗性追问、两次止损、**显式判断终检**（大改动先问用户再派干净子智能体；小改动写明未起终检）、每轮总结与下一步。
2. **门禁**（可拦）：没加载 skill 就改代码 → 直接拒绝，返回明确指令。
3. **验收注入**（每次触发）：`verify.js` 监听 `tools/post-execute`，写代码文件后紧跟一条上下文，列出这一轮必须做的五项；`subagent` 返回后注入「原样呈现 / P0 判不通过 / 细致报告归主智能体」的规则。

注入不阻断调用（门禁负责阻断），所以不会死锁；但文案会原样出现在该次编辑之后，模型绕不过去。

注入的三条纪律（改 `verify.js` 时别破坏）：

- **没落盘的调用不注入**。门禁拒绝、`old_string` 没匹配上的失败 edit，都是 `isError`，一个字节都没写。对它说「刚改了代码」会诱导模型去汇报一次不存在的验证。
- **一轮一次全文**。首条是完整五项（约 700 字），同一轮后续改动降为一行。旧版每改一次贴一遍全文，10 次编辑 = 7000 字常驻上下文。
- **按改动类型分三档**：`code`（源码 + 无扩展名文件）、`config`（依赖清单 / lockfile / CI yml / `.env`）、`doc`（其余）。前两档过门禁，`doc` 一律放行——写笔记和 fixture 不该付加载 skill 的税。分类逻辑在 `shared.js`，门禁与注入共用一份，避免两处漂移。

## 按钮行为

- 只有**会话还没跑过第一轮**（blank）时渲染。
- 点击在「反思模式」与「标准模式」之间切换**本会话**的 preset，只影响这一个会话。
- 开启时弹居中提示卡片，3 秒自动消失，不拦截点击。
- 会话开始后按钮不渲染，模式由会话头部的 preset 标签显示。

## 复盘注入

`retro.js` 在会话第一步读工作目录下的 `.workbuddy/复盘.md`，取最近 5 个 `##` 小节（最多 4000 个 UTF-16 码元，约 12KB 字节）作为一条 user 消息注入。文件不存在就静默跳过，每个会话只注入一次。

三个边界条件已处理：

- **只读尾部 256KB**：复盘是追加式日志，最新内容在末尾。10MB 的文件不会在 pre-step 热路径上阻塞。
- **截断有标记**：超预算时从前面切并追加「…（复盘内容过长，仅保留最近部分）」，不留一个看起来完整的半个小节。
- **读失败可重试**：文件不存在 = 结案；权限/编码等读失败**不置位**，下一步再试。旧版先置位再读，一次瞬时失败会让整个会话再也不注入。

## 门禁的边界

这条边界决定了「没被拦」到底证明了什么，所以写清楚。

- **拦（失败关闭）**：`write`、`edit`、`apply_patch` 写到 `code` 或 `config` 档。参数读不出来时**默认拦**，因为这类调用一定在写盘。
- **拦（模式匹配，失败开放）**：`bash` / `pwsh` 的明显写入形态 —— `>` `>>` 重定向、`Set-Content` / `Out-File`、`sed -i`、`tee`、`git apply`、`prettier --write` 一类。命中 `code`/`config` 目标就要求先加载 skill。
- **不拦**：`.md` 等文档档、读、搜索。
- **可以绕过**：shell 通道是**提高成本**，不是封死。`python gen.py`、`node build.js` 这类「跑一个脚本生成代码」永远拦不住——它长得和普通构建命令一样。
- **解锁**：该 agent 成功调用一次 `skill({ "name": "deepseek-code-supervisor" })`，本会话后续放行。加载失败（`isError`）不放行。子智能体是独立 agent，要各自加载。

⚠️ 结论：**门禁防的是「忘了走流程」，不是「故意绕开」。** 要覆盖 shell 生成的改动，靠的是注入 + skill 里的自检六项，不是门禁。

## 终检子智能体是只读的

终检（L2/L3）的子智能体**只读不写**：它读代码、读产物、跑一条验证命令、出结论，**不修改任何文件**。
这不是「门禁没覆盖它」的空子，是它的职责定义：

- `references/reviewer-brief.md:51`「只出结论，不改代码」
- `:79`「不装依赖、不跑全量测试套件、不重构、不改代码」
- `:169`「你只出结论，不改代码」

**机制与授权是两件事**：它跑 `standard` preset，技术上确实能写——但规则禁止它写。
两者的区别很重要：门禁管的是「忘了加载流程就动手」，终检子智能体从头到尾就不该动手，
所以它不需要门禁，需要的是**明确的只读授权**（已写在 reviewer-brief，派单时原样带上）。

补一句边界：如果它报出的 P0 需要改代码，那是**主智能体**的活，它只负责指出问题。原样呈现它的结论，
不许改写、不许过滤、不许替它软化。

## 验证这个插件自己

```bash
node test.js                                                   # 29 项，运行时 + 打包契约
python skills/deepseek-code-supervisor/scripts/test_scan_risks.py   # 22 项，扫描器的自检
```

两个套件都**故意没做成「跑完打印通过」**——失败时退出码非 0，并逐条打印期望值与实际值。
`test.js` 还做过变异测试：把 `guard.js` 的 `isError` 判断、`shared.js` 的 `.env` 分类、
`verify.js` 的 `isError` 门、`client.js` 的 bundle id 各改坏一次，都变红才算有效。

这条规矩来自本项目自己的教训：**写完不验的断言，和没有断言是一样的**。
插件的 `exports` 里有若干符号专为测试而导出，在 `test.js` 之前它们一个消费者都没有。

## 发布

```bash
python scripts/release_check.py   # 源码级：语法、自测、manifest、浏览器 bundle 契约、市场元数据、密钥扫描
npm pack                          # 打包
python scripts/verify_tarball.py  # 产物级：必需文件、无泄漏、解包后真能按 exports 加载
npm publish
```

两个检查分开是因为 tarball 只在打包后存在；`prepublishOnly` 已挂上源码级检查，漏跑会挡住发布。

**`browser bundle contract` 那条最容易被忽略**：`client.js` 违反 `dsh-client-modules`
的运行时契约（不注册、id 不匹配、顶层副作用、用了 ESM 语法）时，服务端一切正常、
测试全绿，但装到用户机器上**插件根本不出现**。这是唯一只能在发布前拦住的一类错。

## 结构

```
index.js                            skill 提供方（host 平面）
shared.js                           目标分类：code / config / doc，门禁与注入共用
guard.js                            写入门禁（文件工具 + shell 模式匹配）
verify.js                           验收要求注入（含失败不注入、同轮去重）
retro.js                            复盘注入（只读尾部、截断有标记、失败可重试）
client.js                           浏览器 bundle（新会话开关 + 提示卡片）
test.js                             运行时 + 打包契约自测（29 项）
cordis.patch.yml                    host 层：只有 skill 行
locale/                             市场展示元数据（zh / en）
presets/self-reflection.patch.yml   模式定义
scripts/release_check.py            发布前源码级检查
scripts/verify_tarball.py           打包后产物级检查
skills/deepseek-code-supervisor/    SKILL.md + references + templates + scripts
```

## 改

- 改流程：改 `skills/**`，下次加载生效。
- 改人设/硬性要求：改 `presets/self-reflection.patch.yml` 的 `prefix`。
- 改注入文案：改 `verify.js`。
- 改分类口径：改 `shared.js`（**唯一一处**，别在别处复制表）。
- 改扫描规则：改 `scripts/rules.json`，然后必须跑 `python skills/deepseek-code-supervisor/scripts/test_scan_risks.py`。
- 不要门禁：删掉 preset 里 `code-supervisor-guard` 那一行。
