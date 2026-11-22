# 更新记录

本项目的所有重要变更都记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中
- `io.js` 的 CSV / XLSX 解析与逐行校验补自动化用例（当前仅手工验收）
- 页面渲染与弹窗链路的 E2E 测试
- 甘特图拖拽调整

## [0.1.0] - 2026-11-22

首个可运行版本，覆盖执行方案中的 P0 与 P1 范围。

### 新增
- **排产**：九因素归入交付/物料/产能三桶加权评分，按优先级贪心逐日占用产能；三套权重策略（交付优先 / 物料优先 / 产能均衡）；硬约束 HC-01~05 先行校验，存在违规时禁止确认计划；甘特视图与逐工序调整。
- **物料**：两级 BOM 展开，五态齐套判定（齐套 / 部分齐套 / 缺料 / 可齐套 / 到货风险），整单按短板原则判定；物料预留与可用库存扣减。
- **执行**：数量勾稽三闸门（G1 物料可支撑量 / G2 上游可流转量 / G3 完成≤开工），报工履历只增不改，停工记录。
- **交付**：日期链、五类延期识别、发货登记（内部节点）。
- **异常**：自动识别、去重（`dedupeKey`）、状态流转；AI 未接入时的规则摘要降级实现，标注"事实/推测"。
- **版本**：计划版本快照与对比、冻结期判定与解冻留痕。
- **指标**：12 项指标集中定义，每项带公式、口径与可下钻明细；分母为 0 时显示 `—`。
- **数据**：三套固定种子的演示场景（简单 / 中等 / 复杂），结果逐字节可复现；localStorage 持久化与 JSON 备份/恢复；`SEED_REV` 版本不一致时提示重建。
- **导入导出**：CSV / XLSX 解析与逐行校验，主数据可覆盖、单据整批拒绝。

### 工程
- 零依赖静态站点：无构建、无框架、无 CDN，`core/` 不引用 DOM，可直接在 Node 中测试。
- `tests/verify.mjs`：31 项自动化校验（数量守恒、排产可复现、约束拦截、指标无 NaN 等）。
- `tests/check-syntax.mjs`：27 个 ES Module 的语法门禁。
- GitHub Actions：CI（语法 + 校验）与 GitHub Pages 部署。
- 键盘可达性：导航支持 Tab / Enter / Space，`aria-current` 标记当前页，弹窗焦点陷阱与关闭后还焦。
- 站点图标、分享卡片 meta、`.gitignore` / `.gitattributes` / `.editorconfig`。

[Unreleased]: https://github.com/Zoe-sofia/ppd-mvp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Zoe-sofia/ppd-mvp/releases/tag/v0.1.0
