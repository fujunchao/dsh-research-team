/**
 * assessDraft（成稿质量门）单测。样本形态取自 2026-09-26 火影 run 实证泄漏
 * （审稿 feedback 与子代理 transcript 逐字取证）。
 * 运行前置：先 `npm run build`（测试直接 import 编译产物 ../lib/assess.js）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessDraft } from '../lib/assess.js'

// —— 火影 run 第 1 章送审载荷（逐字还原）：占位骨架 + 悬空 ### + 无协议标记 ——
const PLACEHOLDER_SKELETON = `## 第1章 木叶建村前史编年：战国时代、三次忍界大战、九尾之乱与宇智波灭族（建村至正篇开篇前）

[6 prose paragraphs, ~1400字]

### 数据摘要
[table ~24 rows, 5 cols]

**推断依据集中说明（推算日期）** [6 bullets]

### 关键发现
[5 bullets]

###`

// —— 火影 run 第 3 章/修订员实证形态：英文过程自述 ——
const ENGLISH_NOTES = `Excellent. Now I have:

1. DeviantArt thesage2600 URL: https://example.com/journal ✓ (March graduation theory)
2. Reddit Part 1 Timeline: https://example.com/r/Naruto ✓ — full content now visible.

JACKPOT — the last search revealed the composite month-level reconstruction.
Word count check: current draft is 3200 words. Now assemble the final answer.
Option (A) it is. Let me write the chapter next.`

// —— 火影 run 修订员实证形态：全文写进文件后只回传元话语前言 ——
const META_PREAMBLE = `File written. Now the final answer: per the DSH bridging, my final output text is what gets forwarded to the 主理人. It must contain Part 1 (complete revised draft) and Part 2 (修改说明). The file exists as backup. I should output the full content inline.

The file content is exactly what I want to forward. Let me output it as my final message (Part 1 + Part 2), noting the file path. I'll reproduce the content of the file as the final answer.已按审稿意见完成处理，完整修订稿已写入工作区文件 \`chapter1-revised-draft.md\`，以下为全文回传。`

/** 构造一篇合格的中文章节成稿：正文 + 表格 + 链接 + 小结 + 新增来源。 */
function buildGoodChapter() {
  const prose = `**编年方法与锚点。** 原作不设绝对纪年，本章以"木叶历"（以建村为元年）为轴：月日层面取官方人物档案直接记载的生日与明载日期（表中标"确定"）；年份数值层面只能依托设定集年龄链与官方相对表述推算（表中标"推算"）。可用锚点有三套口径：《阵之书》体系下正篇开篇约为木叶62年 ([知乎·关于阵之书的时间问题](https://zhuanlan.zhihu.com/p/34754667))；《临之书》口径为开篇约木叶60年 ([Narutopedia — Geography](https://naruto.fandom.com/wiki/Geography))；社群整理的编年表则以第四次忍界大战结束为木叶64年 ([Narutoverse Historian — Timeline](https://narutoversehistorian.wordpress.com/naruto-timeline-and-birthdays/))。三套口径的换算差异在本章表中逐条注明。`
  const rows = Array.from({ length: 8 }, (_, i) =>
    `| 事件${i + 1}描述 | 木叶${40 + i}年（推算） | 漫画第${100 + i}话 | 角色${i + 1} | 事件简述：${'剧情推进'.repeat(4)} | 推算 | 依据设定集年龄链换算 |`,
  ).join('\n')
  const table = `| 事件名称 | 发生日期 | 所属篇章 | 主要角色 | 事件简述 | 日期性质 | 推断依据 |\n|---|---|---|---|---|---|---|\n${rows}`
  return `## 第1章 木叶建村前史编年\n\n${prose}\n\n${prose}\n\n### 数据摘要\n\n${table}\n\n### 关键发现\n- 关键发现一：木叶纪年为社群推算体系 ([Episode Table](https://example.com/episode-table))\n- 关键发现二：官方仅给出相对表述\n\n【本章小结】\n本章以三套口径交叉锚定木叶纪年，覆盖建村至九尾之乱的里程碑。\n\n## 本章新增来源\n1. [知乎·关于阵之书的时间问题](https://zhuanlan.zhihu.com/p/34754667) — 阵之书口径\n2. [Narutopedia — Geography](https://naruto.fandom.com/wiki/Geography) — 官方历史脉络\n3. [Narutoverse Historian — Timeline](https://narutoversehistorian.wordpress.com/naruto-timeline-and-birthdays/) — 逐年编年表\n4. [百度百科·忍界大战](https://baike.baidu.com/item/x) — 战争起止\n5. [萌娘百科 — 火影忍者](https://moegirl.uk/x) — 剧情梗概`
}

/** 构造一份合格的修订回传：Part 1 全文 + --- + Part 2 修改说明。 */
function buildGoodRevision(prevChars) {
  const body = buildGoodChapter()
  const filler = '\n'.repeat(0) + '修订补充说明段：'.repeat(Math.max(1, Math.ceil(prevChars / 400)))
  return `${body}\n${filler}\n---\n## 修改说明（current_round = 1/3）\n\n### 已解决的必须修改项\n1. [针对审稿意见 1：补来源] 已补 5 条带链接来源\n2. [针对审稿意见 2：日期性质二值化] 全表已复核为 确定/推算 二值`
}

test('占位骨架（火影第1章实证）→ 不合格：占位符/悬空收尾/缺协议标记', () => {
  const r = assessDraft(PLACEHOLDER_SKELETON, { kind: 'chapter' })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.includes('占位符')), JSON.stringify(r.reasons))
  assert.ok(r.reasons.some((x) => x.includes('悬空')), JSON.stringify(r.reasons))
  assert.ok(r.reasons.some((x) => x.includes('【本章小结】')), JSON.stringify(r.reasons))
  assert.ok(r.reasons.some((x) => x.includes('长度')), JSON.stringify(r.reasons))
})

test('英文核证笔记（第2/3章实证）→ 不合格：元话语 + 中文占比', () => {
  const r = assessDraft(ENGLISH_NOTES, { kind: 'chapter', minChars: 100 })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.includes('元话语')), JSON.stringify(r.reasons))
  assert.ok(r.reasons.some((x) => x.includes('占比')), JSON.stringify(r.reasons))
})

test('修订员元话语前言（第1章落档实证）→ 不合格：引导句收尾 + 长度', () => {
  const r = assessDraft(META_PREAMBLE, { kind: 'revision', minChars: Math.max(800, Math.floor(10039 * 0.6)) })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.includes('收尾') || x.includes('元话语')), JSON.stringify(r.reasons))
  assert.ok(r.reasons.some((x) => x.includes('长度')), JSON.stringify(r.reasons))
})

test('合格中文成稿 → 通过（含 [Episode Table](url) 链接不误伤）', () => {
  const r = assessDraft(buildGoodChapter(), { kind: 'chapter' })
  assert.deepEqual(r.reasons, [], JSON.stringify(r.reasons))
})

test('合格修订回传（Part1+---+Part2）→ 通过', () => {
  const prevChars = buildGoodChapter().length
  const r = assessDraft(buildGoodRevision(prevChars), { kind: 'revision', minChars: Math.max(800, Math.floor(prevChars * 0.6)) })
  assert.deepEqual(r.reasons, [], JSON.stringify(r.reasons))
})

test('长中文正文但缺【本章小结】/来源清单 → 不合格', () => {
  const body = buildGoodChapter().split('【本章小结】')[0]
  const r = assessDraft(body, { kind: 'chapter' })
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.includes('【本章小结】') || x.includes('本章新增来源')), JSON.stringify(r.reasons))
})

test('引用密集的中文技术成稿（URL/英文术语多，CJK < 30% 旧阈值会误杀）→ 通过', () => {
  const cjkPart = '本章核心论点是该模型在两条网关下的自适应思考语义并不等同，所谓档位映射本质是把输入压缩到三档刻度而非能力的等价翻译。'.repeat(3)
  const asciiPart = '([GLM-5.3-Flash model page — Artificial Analysis cross-check with Z.AI official docs](https://docs.z.ai/guides/vlm/glm-5.3-flash?utm_source=research&utm_campaign=deep&utm_id=1234567890abcdef)) '.repeat(10)
  const t = `## 第1章 档位机制\n\n${cjkPart}${asciiPart}\n更多交叉验证见官方与第三方托管方实现 ([Deep Thinking — Z.AI](https://docs.z.ai/guides/capabilities/thinking))。\n\n【本章小结】\n完成。\n\n## 本章新增来源\n1. [Z.AI Deep Thinking](https://docs.z.ai/guides/capabilities/thinking) — 档位定义`
  const ratio = [...t.replace(/\s/g, '')].filter((c) => /[\u3400-\u9fff]/.test(c)).length / [...t.replace(/\s/g, '')].length
  assert.ok(ratio < 0.3, `样本应在旧阈值误杀区间，实际 ${(ratio * 100).toFixed(1)}%`)
  const r = assessDraft(t, { kind: 'chapter' })
  assert.deepEqual(r.reasons, [], JSON.stringify(r.reasons))
})

test('占位符匹配先剥离链接：正文中大量 [标题](URL) 引用不误伤', () => {
  const text = `## 第1章 概述\n\n${'根据某研究 ([来源A](https://a.example.com/x))，多项交叉验证的数据显示如下，结论具备多源支撑。'.repeat(20)}\n\n【本章小结】\n完成。\n\n## 本章新增来源\n1. [来源A](https://a.example.com/x)`
  const r = assessDraft(text, { kind: 'chapter' })
  assert.equal(r.ok, true, JSON.stringify(r.reasons))
})
