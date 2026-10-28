#!/usr/bin/env node
// route-phase：判断当前诉求该回到五阶段的哪一阶段，并打印该阶段的准入 / 产出清单。
//
// 用法:
//   node route-phase.js "改了登录接口后，页面点提交就白屏"
//   node route-phase.js --selftest        # 跑路由用例表（可失败的判据）
// 退出码: 0 正常 / 1 自测有失败 / 2 用法错误
//
// 为什么要有这个脚本：三种迭代切入点（新功能→①、性能体验→④、结构混乱→②）在规则里
// 是一句话，但真到"这个改动该回哪"时最容易拍脑袋。把判定写成表，就能被用例钉住。
'use strict';

const STAGES = {
  1: {
    name: '需求澄清',
    must: ['谁用 / 什么场景 / 痛点 / 一次典型流程', '≥3 个异常场景', '可测试的验收标准'],
    forbid: '先不碰技术栈——谈 React / MySQL 这类词就是越级',
    out: 'spec.md（窄契约；此阶段不写实现、不选技术）',
  },
  2: {
    name: '架构',
    must: ['到文件级的目录结构', '每文件职责', '数据流', '模块接口约定', '最脆弱 / 最不确定的一处'],
    forbid: '不写实现代码',
    out: '架构文档（含"最脆弱点"这一节，它是下一阶段排期与验收的依据）',
  },
  3: {
    name: '逐模块生成',
    must: ['每模块的路径 / 职责 / 依赖与对外接口', '一次只在一个模块上下文里写', '每模块配最小验证（至少能 import + 关键函数能调）'],
    forbid: '不跨模块一起写（长对话漂移的源头）',
    out: '可运行的单模块 + 它的最小验证命令',
  },
  4: {
    name: '调试',
    must: ['完整报错 + 触发操作 + 期望 / 实际', '解释原因（1–3 个可能 + 排查顺序）', '分步修、逐步反馈', '三行总结'],
    forbid: '不一次改五个地方；同一问题连续 3 轮没解决就先落盘现场、再换会话换角度',
    out: '修复 + 三行总结（改了什么 / 为什么 / 还剩什么）',
  },
  5: {
    name: '迭代',
    must: ['判断变更类型 → 回 ① / ④ / ②'],
    forbid: '不一律从头重做',
    out: '回到对应阶段的产出',
  },
};

// 路由用例表：每条都是"输入描述 → 期望阶段"。--selftest 逐条核对。
// phase 0 = 不适用五阶段（小改动 / 需求已明确），直接干。
const CASES = [
  { text: '从零做一个带登录和权限的后台', phase: 1 },
  { text: '我想做个很酷的落地页，具体你定', phase: 1 },
  { text: '加一个导出 Excel 的功能', phase: 1 },
  { text: '这个模块要拆成几个文件，想想怎么分', phase: 2 },
  { text: '现在代码结构太乱了，越改越乱', phase: 2 },
  { text: '重构一下目录分层，现在耦合太重', phase: 2 },
  { text: '按架构文档开始写第一个模块的代码', phase: 3 },
  { text: '继续写订单模块的实现', phase: 3 },
  { text: '现在架构撑不住了，要重新分层', phase: 2 },
  { text: '改了登录接口后，页面点提交就白屏', phase: 4 },
  { text: '列表页加载要 8 秒，太慢了', phase: 4 },
  { text: '报错 NullPointerException，帮我看看', phase: 4 },
  { text: '这个动画有点卡，滚起来不跟手', phase: 4 },
  { text: '把按钮文案从「确定」改成「保存」', phase: 0 },
  { text: '修一下这个错别字', phase: 0 },
];

// 判定顺序 = 优先级。顺序错了就会误判——自测里这条就翻过车：
// 「按架构文档开始写第一个模块」含"架构"，先判②就会把"该进③"判成"该进②"。
// 所以**显式的工序指令（按文档写/继续写）必须排在描述性关键词（架构/结构）之前**。
const RULES = [
  { phase: 0, re: /错别字|文案|改个词|一行|一个字段|改个名字|重命名/ },
  // 注意别把"这个模块"当信号——它同样出现在"这个模块要拆成几个文件"（那是②）里，
  // 自测里这条也翻过车。③ 要抓的是**工序指令**：按文档写、继续写、实现这个、写第一个模块。
  { phase: 3, re: /按.{0,8}(架构|文档).{0,8}(写|实现|生成|开工)|继续写|实现这个|写第一个模块/ },
  { phase: 4, re: /崩|白屏|报错|异常|失败|不生效|加载.{0,4}慢|太慢|卡顿|卡住|不跟手|掉帧|超时|内存|泄漏|闪退|挂了|无响应/ },
  { phase: 2, re: /结构乱|越改越乱|耦合|分层|目录结构|架构|拆成几个|模块划分|重构|抽象/ },
  { phase: 1, re: /从零|新做|新建|做个|做一个|加一个|新增|想要|我希望|功能|支持.{0,6}(导出|导入|登录|支付|搜索)/ },
];

function route(text) {
  for (const r of RULES) if (r.re.test(text)) return r.phase;
  return 1; // 说不清诉求时，默认回到需求澄清——这比默认动手安全
}

function show(phase, text) {
  if (phase === 0) {
    console.log(`【不入五阶段】${text}`);
    console.log('  小改动 / 需求已明确 —— 直接改，按常规纪律（改前备份、验证要能失败）走即可。');
    return;
  }
  const s = STAGES[phase];
  console.log(`【建议进入 阶段${phase} · ${s.name}】${text}`);
  console.log('  准入/要点：');
  for (const m of s.must) console.log(`    - ${m}`);
  console.log(`  禁止：${s.forbid}`);
  console.log(`  产出：${s.out}`);
}

function selftest() {
  let bad = 0;
  for (const c of CASES) {
    const got = route(c.text);
    const ok = got === c.phase;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} [期望 ${c.phase} 实际 ${got}] ${c.text}`);
  }
  // 负对照：确保"默认回 ①"这一支真的会被走到，而不是恒被规则命中
  const fallback = route('嗯……这个事你看着办吧');
  const fbOk = fallback === 1;
  if (!fbOk) bad++;
  console.log(`  ${fbOk ? '✓' : '✗'} [缺省兜底 期望 1 实际 ${fallback}] 嗯……这个事你看着办吧`);
  console.log(`路由自测：${CASES.length + 1} 条，失败 ${bad}`);
  return bad === 0 ? 0 : 1;
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) process.exit(selftest());
const text = args.filter((a) => !a.startsWith('--')).join(' ').trim();
if (!text) {
  console.error('用法: node route-phase.js "<变更诉求>"   或   node route-phase.js --selftest');
  process.exit(2);
}
show(route(text), text);
