#!/usr/bin/env python3
"""
 ██████╗ ██████╗ ██████╗ ███████╗ █████╗ ██████╗ ███████╗███╗   ██╗ █████╗
██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗██╔══██╗██╔════╝████╗  ██║██╔══██╗
██║     ██║   ██║██║  ██║█████╗  ███████║██████╔╝█████╗  ██╔██╗ ██║███████║
██║     ██║   ██║██║  ██║██╔══╝  ██╔══██║██╔══██╗██╔══╝  ██║╚██╗██║██╔══██║
╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║██║  ██║███████╗██║ ╚████║██║  ██║
 ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝

CodeArena — Multi-Model Adversarial Code Review Engine
======================================================
让 Claude / GPT / Gemini 在竞技场中对抗博弈，对代码进行深度审查。

模式：
  - adversarial: 对抗辩论 → 攻方 vs 守方 → 仲裁裁决（默认）
  - ensemble:    并行独立审查 → 投票汇总
  - pipeline:    逐模型串联 → 逐层深化

用法：
  python review.py <code_file> [--mode adversarial|ensemble|pipeline]
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

# ─── Model Adapters ──────────────────────────────────────────────────────────

class ModelAdapter:
    """Base class for LLM API adapters."""
    name: str

    def chat(self, system: str, user: str, temperature: float = 0.3) -> str:
        raise NotImplementedError


class ClaudeAdapter(ModelAdapter):
    name = "Claude"

    def __init__(self, model: str = "claude-sonnet-4-5-20250929"):
        import anthropic
        self.client = anthropic.Anthropic()  # uses ANTHROPIC_API_KEY
        self.model = model

    def chat(self, system: str, user: str, temperature: float = 0.3) -> str:
        resp = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            temperature=temperature,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return resp.content[0].text


class GPTAdapter(ModelAdapter):
    name = "GPT"

    def __init__(self, model: str = "gpt-4o"):
        from openai import OpenAI
        self.client = OpenAI()  # uses OPENAI_API_KEY
        self.model = model

    def chat(self, system: str, user: str, temperature: float = 0.3) -> str:
        resp = self.client.chat.completions.create(
            model=self.model,
            temperature=temperature,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return resp.choices[0].message.content


class GeminiAdapter(ModelAdapter):
    name = "Gemini"

    def __init__(self, model: str = "gemini-2.0-flash"):
        import google.generativeai as genai
        self.model = genai.GenerativeModel(
            model,
            system_instruction=None,  # set per call
        )
        self._model_name = model

    def chat(self, system: str, user: str, temperature: float = 0.3) -> str:
        import google.generativeai as genai
        model = genai.GenerativeModel(
            self._model_name,
            system_instruction=system,
            generation_config=genai.types.GenerationConfig(temperature=temperature),
        )
        resp = model.generate_content(user)
        return resp.text


# ─── Prompts ─────────────────────────────────────────────────────────────────

REVIEW_SYSTEM = """你是一位资深代码审查专家。请对以下代码进行严格审查，输出 JSON 格式：
{
  "summary": "一句话总结代码质量",
  "issues": [
    {
      "severity": "critical|high|medium|low",
      "category": "bug|security|performance|style|logic|maintainability",
      "line": "行号或行号范围（如不确定可写 null）",
      "description": "问题描述",
      "suggestion": "修复建议"
    }
  ],
  "strengths": ["代码的优点"],
  "score": 0-10
}
只输出 JSON，不要输出其他内容。"""

CHALLENGE_SYSTEM = """你是一位代码审查的反方辩手。你的职责是：
1. 逐条审视对方的审查意见
2. 如果你认为某条意见是 **错误的或过度的**，请反驳并说明理由
3. 如果你认为某条意见是 **正确的**，请确认
4. 补充对方 **遗漏的** 重要问题

输出 JSON 格式：
{
  "rebuttals": [
    {
      "original_issue": "对方原始意见摘要",
      "verdict": "agree|disagree|partially_agree",
      "reasoning": "你的理由"
    }
  ],
  "missed_issues": [
    {
      "severity": "critical|high|medium|low",
      "category": "bug|security|performance|style|logic|maintainability",
      "line": "行号或 null",
      "description": "遗漏的问题",
      "suggestion": "修复建议"
    }
  ]
}
只输出 JSON，不要输出其他内容。"""

ARBITRATE_SYSTEM = """你是代码审查的最终仲裁者。你将看到：
1. 原始代码
2. 审查方的意见
3. 反方的反驳和补充

请综合双方意见，输出最终裁定，JSON 格式：
{
  "final_summary": "最终综合评价",
  "confirmed_issues": [
    {
      "severity": "critical|high|medium|low",
      "category": "bug|security|performance|style|logic|maintainability",
      "line": "行号或 null",
      "description": "确认的问题",
      "suggestion": "修复建议",
      "consensus": "both_agree | reviewer_only | challenger_only"
    }
  ],
  "dismissed_issues": [
    {
      "original_issue": "被驳回的意见",
      "reason": "驳回理由"
    }
  ],
  "final_score": 0-10,
  "verdict": "approve | request_changes | needs_discussion"
}
只输出 JSON，不要输出其他内容。"""


# ─── Core Engine ─────────────────────────────────────────────────────────────

def log(icon: str, msg: str):
    print(f"  {icon}  {msg}")


def safe_json_parse(text: str) -> dict:
    """Try to parse JSON, handling markdown code fences."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
        if text.startswith("json"):
            text = text[4:].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw_response": text, "parse_error": True}


def detect_available_models() -> list[ModelAdapter]:
    """Auto-detect which model APIs are available via env vars."""
    models = []

    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            models.append(ClaudeAdapter())
            log("✅", "Claude (Anthropic) — ready")
        except Exception as e:
            log("⚠️", f"Claude init failed: {e}")

    if os.environ.get("OPENAI_API_KEY"):
        try:
            models.append(GPTAdapter())
            log("✅", "GPT (OpenAI) — ready")
        except Exception as e:
            log("⚠️", f"GPT init failed: {e}")

    if os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY"):
        try:
            models.append(GeminiAdapter())
            log("✅", "Gemini (Google) — ready")
        except Exception as e:
            log("⚠️", f"Gemini init failed: {e}")

    return models


def run_review(model: ModelAdapter, code: str) -> dict:
    """Run a single model review."""
    log("🔍", f"{model.name} 正在审查代码...")
    t0 = time.time()
    raw = model.chat(REVIEW_SYSTEM, f"请审查以下代码：\n\n```\n{code}\n```")
    elapsed = time.time() - t0
    log("⏱️", f"{model.name} 审查完成 ({elapsed:.1f}s)")
    result = safe_json_parse(raw)
    result["_model"] = model.name
    result["_elapsed"] = round(elapsed, 1)
    return result


def run_challenge(model: ModelAdapter, code: str, review: dict) -> dict:
    """Challenge another model's review."""
    log("⚔️", f"{model.name} 正在反驳...")
    review_text = json.dumps(review, ensure_ascii=False, indent=2)
    prompt = f"原始代码：\n```\n{code}\n```\n\n对方审查意见：\n{review_text}"
    t0 = time.time()
    raw = model.chat(CHALLENGE_SYSTEM, prompt)
    elapsed = time.time() - t0
    log("⏱️", f"{model.name} 反驳完成 ({elapsed:.1f}s)")
    result = safe_json_parse(raw)
    result["_model"] = model.name
    result["_elapsed"] = round(elapsed, 1)
    return result


def run_arbitration(model: ModelAdapter, code: str, review: dict, challenge: dict) -> dict:
    """Final arbitration combining review and challenge."""
    log("⚖️", f"{model.name} 正在做最终仲裁...")
    prompt = (
        f"原始代码：\n```\n{code}\n```\n\n"
        f"审查方意见：\n{json.dumps(review, ensure_ascii=False, indent=2)}\n\n"
        f"反方意见：\n{json.dumps(challenge, ensure_ascii=False, indent=2)}"
    )
    t0 = time.time()
    raw = model.chat(ARBITRATE_SYSTEM, prompt)
    elapsed = time.time() - t0
    log("⏱️", f"{model.name} 仲裁完成 ({elapsed:.1f}s)")
    result = safe_json_parse(raw)
    result["_model"] = model.name
    result["_elapsed"] = round(elapsed, 1)
    return result


# ─── Review Modes ────────────────────────────────────────────────────────────

def mode_adversarial(models: list[ModelAdapter], code: str) -> dict:
    """
    对抗辩论模式（推荐）：
      Model A → 审查
      Model B → 反驳 + 补充
      Model C → 仲裁（如只有 2 个模型则 A 仲裁）
    """
    print("\n🥊 CodeArena — 对抗辩论模式 (Adversarial Debate)")
    print("=" * 55)

    reviewer = models[0]
    challenger = models[1]
    arbitrator = models[2] if len(models) >= 3 else models[0]

    print(f"\n📋 角色分配：")
    print(f"   审查方: {reviewer.name}")
    print(f"   反方:   {challenger.name}")
    print(f"   仲裁:   {arbitrator.name}")
    print()

    # Round 1: Review
    print("─── Round 1: 审查 ───")
    review = run_review(reviewer, code)

    # Round 2: Challenge
    print("\n─── Round 2: 反驳 ───")
    challenge = run_challenge(challenger, code, review)

    # Round 3: Arbitration
    print("\n─── Round 3: 仲裁 ───")
    final = run_arbitration(arbitrator, code, review, challenge)

    return {
        "mode": "adversarial",
        "review": review,
        "challenge": challenge,
        "arbitration": final,
    }


def mode_ensemble(models: list[ModelAdapter], code: str) -> dict:
    """
    并行投票模式：
      所有模型独立审查 → 汇总对比
    """
    print("\n🗳️  CodeArena — 并行投票模式 (Ensemble)")
    print("=" * 55)

    reviews = []
    for m in models:
        reviews.append(run_review(m, code))

    # Summarize consensus
    all_issues = []
    for r in reviews:
        model_name = r.get("_model", "unknown")
        for issue in r.get("issues", []):
            issue["_found_by"] = model_name
            all_issues.append(issue)

    return {
        "mode": "ensemble",
        "reviews": reviews,
        "all_issues": all_issues,
        "total_issues": len(all_issues),
    }


def mode_pipeline(models: list[ModelAdapter], code: str) -> dict:
    """
    流水线模式：
      Model A 审查 → Model B 在 A 的基础上复审 → Model C 最终审查
    """
    print("\n🔗 CodeArena — 流水线模式 (Pipeline)")
    print("=" * 55)

    stages = []
    accumulated_context = ""

    for i, m in enumerate(models):
        stage_name = ["初审", "复审", "终审"][i] if i < 3 else f"第{i+1}轮审查"
        print(f"\n─── {stage_name}: {m.name} ───")

        if i == 0:
            result = run_review(m, code)
        else:
            # 后续模型看到之前的审查结果
            system = f"""你是代码审查的{stage_name}专家。请基于前面审查者的意见，进行更深入的审查：
1. 确认或反驳前面的发现
2. 补充遗漏的问题
3. 给出你自己的综合评分

输出 JSON 格式：
{{
  "summary": "综合评价",
  "confirmed": ["确认的问题"],
  "disputed": ["不同意的问题及理由"],
  "new_issues": [
    {{
      "severity": "critical|high|medium|low",
      "category": "bug|security|performance|style|logic|maintainability",
      "description": "新发现的问题",
      "suggestion": "修复建议"
    }}
  ],
  "score": 0-10
}}
只输出 JSON，不要输出其他内容。"""

            prompt = (
                f"原始代码：\n```\n{code}\n```\n\n"
                f"前面的审查结果：\n{accumulated_context}"
            )
            log("🔍", f"{m.name} 正在{stage_name}...")
            t0 = time.time()
            raw = m.chat(system, prompt)
            elapsed = time.time() - t0
            log("⏱️", f"{m.name} {stage_name}完成 ({elapsed:.1f}s)")
            result = safe_json_parse(raw)
            result["_model"] = m.name
            result["_elapsed"] = round(elapsed, 1)

        result["_stage"] = stage_name
        stages.append(result)
        accumulated_context += f"\n\n--- {m.name} ({stage_name}) ---\n{json.dumps(result, ensure_ascii=False, indent=2)}"

    return {
        "mode": "pipeline",
        "stages": stages,
    }


# ─── Report Generator ────────────────────────────────────────────────────────

SEVERITY_EMOJI = {
    "critical": "🔴",
    "high": "🟠",
    "medium": "🟡",
    "low": "🟢",
}


def generate_report(result: dict, code_file: str, code: str) -> str:
    """Generate a Markdown report from review results."""
    lines = []
    lines.append(f"# ⚔️ CodeArena — Code Review Report")
    lines.append(f"")
    lines.append(f"- **文件**: `{code_file}`")
    lines.append(f"- **模式**: {result['mode']}")
    lines.append(f"- **时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append(f"")

    if result["mode"] == "adversarial":
        # ── Adversarial Report ──
        review = result["review"]
        challenge = result["challenge"]
        arb = result["arbitration"]

        lines.append(f"## ⚔️ 对抗辩论过程")
        lines.append(f"")

        # Reviewer findings
        lines.append(f"### Round 1: {review.get('_model', '?')} 审查")
        lines.append(f"")
        if not review.get("parse_error"):
            lines.append(f"> {review.get('summary', 'N/A')}")
            lines.append(f"")
            for issue in review.get("issues", []):
                sev = issue.get("severity", "medium")
                emoji = SEVERITY_EMOJI.get(sev, "⚪")
                lines.append(f"- {emoji} **[{sev.upper()}]** {issue.get('description', '')}")
                if issue.get("suggestion"):
                    lines.append(f"  - 💡 {issue['suggestion']}")
            lines.append(f"")

        # Challenger rebuttals
        lines.append(f"### Round 2: {challenge.get('_model', '?')} 反驳")
        lines.append(f"")
        if not challenge.get("parse_error"):
            for reb in challenge.get("rebuttals", []):
                verdict = reb.get("verdict", "?")
                icon = {"agree": "✅", "disagree": "❌", "partially_agree": "🤔"}.get(verdict, "❓")
                lines.append(f"- {icon} **{verdict}**: {reb.get('original_issue', '')}")
                lines.append(f"  - {reb.get('reasoning', '')}")
            if challenge.get("missed_issues"):
                lines.append(f"")
                lines.append(f"**补充遗漏的问题：**")
                for issue in challenge["missed_issues"]:
                    sev = issue.get("severity", "medium")
                    emoji = SEVERITY_EMOJI.get(sev, "⚪")
                    lines.append(f"- {emoji} **[{sev.upper()}]** {issue.get('description', '')}")
            lines.append(f"")

        # Arbitration
        lines.append(f"### Round 3: {arb.get('_model', '?')} 仲裁")
        lines.append(f"")
        if not arb.get("parse_error"):
            lines.append(f"> {arb.get('final_summary', 'N/A')}")
            lines.append(f"")

            verdict = arb.get("verdict", "?")
            verdict_icon = {
                "approve": "✅ 通过",
                "request_changes": "🔄 需要修改",
                "needs_discussion": "💬 需要讨论",
            }.get(verdict, verdict)
            lines.append(f"**最终裁定: {verdict_icon}**")
            lines.append(f"**评分: {arb.get('final_score', '?')}/10**")
            lines.append(f"")

            if arb.get("confirmed_issues"):
                lines.append(f"#### ✅ 确认的问题")
                lines.append(f"")
                for issue in arb["confirmed_issues"]:
                    sev = issue.get("severity", "medium")
                    emoji = SEVERITY_EMOJI.get(sev, "⚪")
                    consensus = issue.get("consensus", "")
                    lines.append(f"- {emoji} **[{sev.upper()}]** {issue.get('description', '')} `({consensus})`")
                    if issue.get("suggestion"):
                        lines.append(f"  - 💡 {issue['suggestion']}")
                lines.append(f"")

            if arb.get("dismissed_issues"):
                lines.append(f"#### ❌ 驳回的意见")
                lines.append(f"")
                for d in arb["dismissed_issues"]:
                    lines.append(f"- ~~{d.get('original_issue', '')}~~ — {d.get('reason', '')}")
                lines.append(f"")

    elif result["mode"] == "ensemble":
        # ── Ensemble Report ──
        lines.append(f"## 🗳️ 各模型独立审查结果")
        lines.append(f"")
        for review in result.get("reviews", []):
            lines.append(f"### {review.get('_model', '?')} (评分: {review.get('score', '?')}/10, 耗时: {review.get('_elapsed', '?')}s)")
            lines.append(f"")
            if not review.get("parse_error"):
                lines.append(f"> {review.get('summary', 'N/A')}")
                lines.append(f"")
                for issue in review.get("issues", []):
                    sev = issue.get("severity", "medium")
                    emoji = SEVERITY_EMOJI.get(sev, "⚪")
                    lines.append(f"- {emoji} **[{sev.upper()}]** {issue.get('description', '')}")
                lines.append(f"")

        lines.append(f"### 📊 汇总统计")
        lines.append(f"- 总发现问题数: {result.get('total_issues', 0)}")
        lines.append(f"")

    elif result["mode"] == "pipeline":
        # ── Pipeline Report ──
        lines.append(f"## 🔗 流水线审查过程")
        lines.append(f"")
        for stage in result.get("stages", []):
            lines.append(f"### {stage.get('_stage', '?')}: {stage.get('_model', '?')} ({stage.get('_elapsed', '?')}s)")
            lines.append(f"")
            if not stage.get("parse_error"):
                lines.append(f"> {stage.get('summary', 'N/A')}")
                lines.append(f"")
                for issue in stage.get("issues", stage.get("new_issues", [])):
                    sev = issue.get("severity", "medium")
                    emoji = SEVERITY_EMOJI.get(sev, "⚪")
                    lines.append(f"- {emoji} **[{sev.upper()}]** {issue.get('description', '')}")
                lines.append(f"")

    # Footer
    lines.append(f"---")
    lines.append(f"*Generated by CodeArena v0.1 — Multi-Model Adversarial Code Review Engine*")

    return "\n".join(lines)


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="⚔️  CodeArena — Multi-Model Adversarial Code Review Engine",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  codearena app.py                          # 默认对抗辩论模式
  codearena app.py --mode ensemble          # 并行投票模式
  codearena app.py --mode pipeline          # 流水线模式
  codearena app.py -o report.md             # 输出到文件

环境变量（至少设置 2 个）：
  ANTHROPIC_API_KEY    Claude API key
  OPENAI_API_KEY       OpenAI API key
  GOOGLE_API_KEY       Gemini API key
        """,
    )
    parser.add_argument("file", help="要审查的代码文件")
    parser.add_argument(
        "--mode", "-m",
        choices=["adversarial", "ensemble", "pipeline"],
        default="adversarial",
        help="审查模式 (默认: adversarial)",
    )
    parser.add_argument("--output", "-o", help="输出 Markdown 报告的路径")
    parser.add_argument("--json", "-j", action="store_true", help="同时输出原始 JSON 数据")

    args = parser.parse_args()

    # Read code file
    code_path = Path(args.file)
    if not code_path.exists():
        print(f"❌ 文件不存在: {args.file}")
        sys.exit(1)

    code = code_path.read_text(encoding="utf-8")
    print(f"\n📄 读取文件: {args.file} ({len(code)} chars, {len(code.splitlines())} lines)")

    # Detect models
    print(f"\n🔎 检测可用模型...")
    models = detect_available_models()

    if len(models) < 2:
        print(f"\n❌ 至少需要 2 个可用模型，当前只有 {len(models)} 个。")
        print(f"   请设置环境变量：ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY")
        sys.exit(1)

    print(f"\n✨ {len(models)} 个模型就绪，开始 {args.mode} 模式审查...\n")

    # Run selected mode
    t_start = time.time()

    if args.mode == "adversarial":
        result = mode_adversarial(models, code)
    elif args.mode == "ensemble":
        result = mode_ensemble(models, code)
    elif args.mode == "pipeline":
        result = mode_pipeline(models, code)

    total_time = time.time() - t_start
    print(f"\n⏱️  总耗时: {total_time:.1f}s")

    # Generate report
    report = generate_report(result, args.file, code)

    # Output
    output_path = args.output or f"review_{code_path.stem}_{args.mode}.md"
    Path(output_path).write_text(report, encoding="utf-8")
    print(f"\n📝 报告已保存: {output_path}")

    if args.json:
        json_path = output_path.replace(".md", ".json")
        Path(json_path).write_text(
            json.dumps(result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"📦 JSON 数据: {json_path}")

    print(f"\n{'='*50}")
    print(report)


if __name__ == "__main__":
    main()
