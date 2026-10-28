#!/usr/bin/env node
/**
 * 悬空引用扫描脚本
 * 
 * 输入：技能目录路径
 * 输出：JSON 格式的引用清单（existing / missing 分档）
 * 退出码：0 = 全存在，1 = 有缺失
 */

const fs = require('fs');
const path = require('path');

if (process.argv.length < 3) {
  console.error('用法: node audit-references.cjs <技能目录>');
  process.exit(2);
}

const skillDir = process.argv[2];

if (!fs.existsSync(skillDir)) {
  console.error(`错误: 目录不存在 ${skillDir}`);
  process.exit(2);
}

const skillMdPath = path.join(skillDir, 'SKILL.md');
if (!fs.existsSync(skillMdPath)) {
  console.error(`错误: SKILL.md 不存在 ${skillMdPath}`);
  process.exit(2);
}

const skillMdContent = fs.readFileSync(skillMdPath, 'utf-8');

// 提取 scripts/ 和 references/ 的引用（只匹配完整文件路径，排除代码块和示例）
const lines = skillMdContent.split('\n');
const uniqueRefs = new Set();
let inCodeBlock = false;

for (const line of lines) {
  // 跳过代码块
  if (line.trim().startsWith('```')) {
    inCodeBlock = !inCodeBlock;
    continue;
  }
  if (inCodeBlock) continue;
  
  // 跳过示例行（包含「旧引用」「现位置」「如」等关键词）
  if (line.includes('旧引用') || line.includes('现位置') || line.includes('如 `') || line.includes('example')) continue;
  
  // 匹配完整路径：scripts/xxx.cjs 或 references/xxx.md
  const matches = line.match(/(scripts|references)\/[a-zA-Z0-9_.-]+\.(cjs|md)/g) || [];
  for (const ref of matches) {
    uniqueRefs.add(ref);
  }
}

const existing = [];
const missing = [];

for (const ref of uniqueRefs) {
  const fullPath = path.join(skillDir, ref);
  if (fs.existsSync(fullPath)) {
    existing.push(ref);
  } else {
    missing.push(ref);
  }
}

const result = { existing, missing };
console.log(JSON.stringify(result, null, 2));

process.exit(missing.length > 0 ? 1 : 0);
