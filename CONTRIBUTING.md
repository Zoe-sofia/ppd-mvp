# 参与贡献

感谢愿意花时间改进这个项目。它不大，但有几条约定请务必遵守 —— 破坏它们会让代码很快退化成"页面里塞满计算逻辑"的常见形态。

## 快速上手

```bash
git clone https://github.com/Zoe-sofia/ppd-mvp.git
cd ppd-mvp/app

npm start          # http://127.0.0.1:8099
npm test           # 31 项校验，必须全绿
npm run check      # 语法门禁
```

不需要 `npm install` —— 本项目没有任何依赖，这是刻意的设计，请勿引入运行时依赖、CDN 资源或构建步骤。

## 最重要的一条：分层纪律

```
core/  ← 业务规则、算法、口径。不引用任何 DOM API，可在 Node 里直接 import
io.js  ← 解析与校验（CSV / XLSX）
ui/    ← 只取数与渲染，不做计算
```

- **不要在 `ui/pages/` 里写业务规则。** 需要新规则就放进 `core/`，页面只调用。
- **不要在 `core/` 里碰 `document` / `window` / `localStorage`**（`core/store.js` 是唯一例外，它就是持久层）。`core/` 一旦依赖 DOM，测试就跑不起来了。
- **口径只能有一个来源。** 状态枚举、约束清单、指标公式统一放 `core/constants.js` 与 `core/metrics.js`，不要在页面里复制一份字符串常量。

## 改动类型与要求

| 改动 | 要求 |
|---|---|
| 新增业务规则 | 在 `core/` 实现 + 在 `tests/verify.mjs` 加一条能证伪它的用例；违规必须给出四要素（对象·原因·影响·去哪看） |
| 修改排产算法 | 必须保持**可复现**（同输入两次结果一致）与**顺序无关**（约束判定不依赖任务数组顺序）；`npm test` 里已有对应断言 |
| 修改指标口径 | 同步更新 `core/metrics.js` 里的 `formula` / `basis`，并在 PR 描述里写清分母分子变化；口径变更属于破坏性变更 |
| 新增页面 | 在 `ui/pages/` 新建模块并导出 `{ render(view, ctx) }`，在 `app.js` 的 `PAGES` 注册；页面不得直接读写 `localStorage`，改数据走 `ctx.commit()` |
| 样式改动 | 只用 `assets/css/app.css` 里已有的 CSS 变量（`--brand`、`--ok`、`--warn` 等），不要硬编码色值 |
| 修复缺陷 | 尽量补一条能复现该缺陷的用例 |

## 提交信息

采用 Conventional Commits 前缀，一句话说清"改了什么、为什么"：

```
feat(scheduler): 产能按物理量占用，避免账面不超产能实际超工时
fix(exec): 完工申报重复提交时未拦截
docs(readme): 补充浏览器兼容矩阵
test(metrics): 覆盖分母为 0 时显示 —
```

常用前缀：`feat` / `fix` / `docs` / `test` / `refactor` / `chore`。

## 提交 PR 前

- [ ] `npm test` 与 `npm run check` 全绿
- [ ] 没有新增依赖、没有引入 CDN、没有新增构建步骤
- [ ] 业务规则在 `core/`，页面里没有计算逻辑
- [ ] 涉及口径变更时，PR 描述里写清了旧口径与新口径的差异
- [ ] 手工点过受影响页面的主流程（开工 / 完工 / 排产 / 导入至少各一次）

## Issue

- **缺陷**：请附复现步骤、浏览器与版本、期望结果与实际结果；如果是数据问题，说明用的是哪套演示场景。
- **功能建议**：先说清场景（谁在什么环节遇到什么问题），再说方案。方案 §10 已明确不做的部分（报废/返工、多工厂、ERP 集成、权限体系等）请先讨论范围。

## 许可证

提交即表示你同意以 [MIT](./LICENSE) 许可证授权你的贡献。
