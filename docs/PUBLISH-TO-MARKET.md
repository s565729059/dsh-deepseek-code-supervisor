# 上架 DSH 市场

> 结论先说：**DSH 市场不看 npm，看的是一个 GitHub 仓库里的 YAML 条目。**
> `npm publish` 不是上架的必要条件，走 GitHub 就够。

---

## 一、市场到底是什么

[Awesome DSH Plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 是一个**注册表仓库**。
DSH 的市场列表读它的 `data/plugins/*.yml`。

上架 = 向那个仓库提一个 PR，加**一个 YAML 文件**（每个插件一个文件，永不冲突）。

```
data/plugins/<owner>__<repo>.yml
```

我们的是 `data/plugins/s565729059__dsh-deepseek-code-supervisor.yml`。

---

## 二、硬性门槛（CI 自动校验，缺一条红）

| 条件 | 校验位置 | 我们 |
|---|---|---|
| `package.json` 声明 `dsh.bundle` | `check-submission.mjs` | ✅ `bundle.patch` 两条 |
| 仓库存在且未归档 | 同上 | ✅ public |
| 仓库创建**满 1 天** | `MIN_AGE_DAYS = 1` | ⏳ 见第四节 |
| 仓库打 `dsh-plugin` topic | 人工/CI | ✅ 已有 |
| 仓库有真实代码，非占位 | 人工 | ✅ 6 模块 1092 行 |

⚠️ **最常见的被拒原因是只声明了 `dsh.client`**。只 `dsh.client` 装不上，必须有 `dsh.bundle`。我们有，没问题。

---

## 三、条目格式

```yaml
url: https://github.com/s565729059/dsh-deepseek-code-supervisor
name: s565729059/dsh-deepseek-code-supervisor
category: workflow
description:
  en: <一行，句号结尾；含 ": " 必须整行加引号>
  zh: <可选，维护者会补>
```

- `url` 必须与仓库地址**完全一致**
- `name` 是 `owner/repo`
- `category` 取值之一：`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`
- 分类选不准不会被打回，维护者直接改
- `icon` 可选，**必须是 GitHub 托管的位图**（png/jpg/webp），SVG 和第三方图床会被拒

---

## 四、现在卡在哪：仓库年龄

仓库创建于 `2026-11-13T07:38:28Z`，门槛 1 天。

**门槛达成：2026-11-14 07:38 UTC ＝ 北京时间 2026-11-14 15:38**

CI 每次重跑都会重新判断，所以**不需要重新提交**。到点后 PR 的检查会自动变绿。

---

## 五、提交流程

```sh
# 1. fork + clone
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin

# 2. 同步 main，建分支
git checkout main && git pull upstream main
git checkout -b add-dsh-deepseek-code-supervisor

# 3. 只加这一个文件，不要动别人的条目，不要手改 README
cp <本仓库>/awesome-dsh-plugin-submission/s565729059__dsh-deepseek-code-supervisor.yml \
   data/plugins/s565729059__dsh-deepseek-code-supervisor.yml

# 4. 推送并开 PR
git add data/plugins/s565729059__dsh-deepseek-code-supervisor.yml
git commit -m "Add s565729059/dsh-deepseek-code-supervisor"
git push -u origin add-dsh-deepseek-code-supervisor
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add s565729059/dsh-deepseek-code-supervisor" --body "..."
```

**不要手工编辑两个 README**——它们是脚本生成的，手改会因行号移位落到邻居条目上。

---

## 六、评审看什么（决定描述怎么写）

CI 绿只是**前置条件**，不是结论。合并前维护者会**实际读仓库**。

1. **代码是否与声明一致** —— 包括描述里的数字和 API 名称
2. 分类是否合理（不会因此打回）
3. 是否真实可用代码
4. 是否已被现有条目覆盖
5. 源码有无可疑（混淆、凭据外传、异常安装行为）
6. PR 是否动了无关条目
7. **是否纯聚合包** —— 只有依赖清单、自己不带行为的聚合包**不单独收录**。我们自带 1092 行行为代码，不是这种。
8. 依赖是否指向原作者

> **描述必须属实，夸大是让一个好插件被打回的主要原因。**

本仓库的描述已逐句对代码核过，见 `scripts/` 之外的核验记录（15 项全过）：预设注册、写入门禁、注入、只读终检、收尾两块、非聚合包、manifest、格式、分类、无营销词。

---

## 七、被拒怎么办

- 反馈以 PR 评论给出，明确说要改什么
- `held: author` 标签只是暂停在合并队列，**不是拒绝**
- 推到同一分支 + 留**一条**说明改了什么，就是全部信号
- **不要反复催**：反复推送或连发追问都不会更快

---

## 八、npm 呢？

可选。条目里的 `tarball` 字段用不上——DSH 用 `dsh plugin add <GitHub 地址>` 安装。

如果以后要发 npm，注意本机 `registry.npmjs.org` 当前不可达（`ECONNRESET`），`npm login` 同样失败，需要先解决网络。
