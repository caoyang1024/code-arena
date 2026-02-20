```
 ██████╗ ██████╗ ██████╗ ███████╗ █████╗ ██████╗ ███████╗███╗   ██╗ █████╗
██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝████╗  ██║██╔══██╗
██║     ██║   ██║██║  ██║█████╗  ███████║██████╔╝█████╗  ██╔██╗ ██║███████║
██║     ██║   ██║██║  ██║██╔══╝  ██╔══██║██╔══██╗██╔══╝  ██║╚██╗██║██╔══██║
╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║██║  ██║███████╗██║ ╚████║██║  ██║
 ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝
```

# ⚔️ CodeArena

**Multi-Model Adversarial Code Review Engine**

> 让 Claude、GPT、Gemini 在竞技场中博弈对抗，碾压你代码里的每一个 bug。

---

## 为什么需要 CodeArena？

单个 AI 模型做 code review 存在系统性盲点。不同模型有不同的训练数据和偏见——Claude 偏重安全性，GPT 擅长模式识别，Gemini 在推理任务上有独到之处。

**CodeArena 让它们互相挑战**，发现单模型永远不会提出的问题。

## 三大竞技模式

### ⚔️ Adversarial — 对抗辩论（默认 · 推荐）

```
┌─────────┐    ┌───────────┐    ┌──────────┐
│ Model A  │───▶│  Model B  │───▶│ Model C  │
│  审查方  │    │   反方    │    │   仲裁   │
└─────────┘    └───────────┘    └──────────┘
```

攻方审查 → 守方反驳 + 补充 → 仲裁者裁决。最深度的审查模式。

### 🗳️ Ensemble — 并行投票

```
Model A ─┐
Model B ─┼──▶ 汇总对比 ──▶ 最终报告
Model C ─┘
```

三模型独立审查，共识优先，分歧标注。

### 🔗 Pipeline — 流水线

```
Model A ──▶ Model B ──▶ Model C
 初审         复审        终审
```

逐层深化，后者看到前者输出。

## 快速开始

### 安装

```bash
git clone https://github.com/yourname/codearena.git
cd codearena
pip install -r requirements.txt
```

### 配置 API Keys（至少 2 个）

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GOOGLE_API_KEY="AI..."
```

### 开打

```bash
# 对抗辩论（默认）
python review.py your_code.py

# 并行投票
python review.py your_code.py --mode ensemble

# 流水线
python review.py your_code.py --mode pipeline

# 输出到文件 + 原始 JSON
python review.py your_code.py -o report.md --json
```

### 试试示例

项目附带一个故意埋了一堆漏洞的文件：

```bash
python review.py sample_buggy_code.py
```

看看三个模型能互怼出什么结果。

## CI/CD 集成

项目包含 GitHub Actions workflow。PR 打上 `deep-review` 标签 → 自动触发 → 审查结果贴回 PR comment。

```yaml
# .github/workflows/multi-model-review.yml
on:
  pull_request:
    types: [labeled]
# 触发条件：标签 = "deep-review"
```

### 设置

1. Repo → Settings → Secrets → 添加 API keys
2. 复制 `.github/workflows/multi-model-review.yml` 到你的项目
3. PR 打标签 `deep-review`

## 输出示例

```
🥊 CodeArena — 对抗辩论模式 (Adversarial Debate)
=======================================================

📋 角色分配：
   审查方: Claude
   反方:   GPT
   仲裁:   Gemini

─── Round 1: 审查 ───
  🔍  Claude 正在审查代码...
  ⏱️  Claude 审查完成 (3.2s)

─── Round 2: 反驳 ───
  ⚔️  GPT 正在反驳...
  ⏱️  GPT 反驳完成 (2.8s)

─── Round 3: 仲裁 ───
  ⚖️  Gemini 正在做最终仲裁...
  ⏱️  Gemini 仲裁完成 (2.5s)

⏱️  总耗时: 8.5s
📝 报告已保存: review_app_adversarial.md
```

## 自定义

### 指定模型版本

```python
models = [
    ClaudeAdapter(model="claude-opus-4-5-20250929"),
    GPTAdapter(model="gpt-4o"),
    GeminiAdapter(model="gemini-2.0-flash"),
]
```

### 注入团队编码规范

修改 `REVIEW_SYSTEM` prompt：

```python
REVIEW_SYSTEM = """你是一位资深代码审查专家。
请特别关注：
- PEP 8 规范
- 所有 API 必须有 rate limiting
- 数据库操作必须使用 ORM
..."""
```

## 成本估算

| 模式 | API 调用 | 约成本/次 |
|------|---------|----------|
| Adversarial | 3 | ~$0.05–0.15 |
| Ensemble | 2–3 | ~$0.04–0.12 |
| Pipeline | 2–3 | ~$0.04–0.12 |

*基于 ~200 行代码，默认模型。*

## License

MIT
