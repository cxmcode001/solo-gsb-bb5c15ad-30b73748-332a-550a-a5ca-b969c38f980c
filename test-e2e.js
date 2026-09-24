'use strict';

/* 端到端场景验证（启动 server 后运行：node test-e2e.js） */

const BASE = process.env.BASE || 'http://localhost:3000';

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${json.error}`);
  return json;
}

async function main() {
  // ---------- 初版（11 行，含重复台词）----------
  const v1 = [
    '第一场 车站',          // 0
    '林夏：有人吗？',        // 1
    '（雨声）',             // 2
    '周野：我等一个人。',    // 3  ← 雨声音效（重复台词 A）
    '灯光转暗。',           // 4  ← 暖光（唯一句）
    '',
    '第二场 月台',          // 5
    '林夏：有人吗？',        // 6
    '（风声）',             // 7
    '周野：我等一个人。',    // 8  ← 月台蓝光（重复台词 B）
    '列车进站。',           // 9  ← 火车轰鸣（稍后改写）
    '大幕缓缓落下。',       // 10 ← 谢幕光（稍后整句删除，无相近候选）
  ].join('\n');

  const script = await req('POST', '/api/scripts', {
    title: '雨夜候车室（测试）',
    note: '初版',
    content: v1,
  });
  const sid = script.id;
  const lines = script.lines;
  console.log(`创建剧本 #${sid}，解析出行数=${lines.length}`);
  check('空行被过滤、其余行保留', lines.length === 11, JSON.stringify(lines));
  check('场景行保留', lines[0] === '第一场 车站');

  const idxUnique = 4;
  const idxDupeA = 3;
  const idxDupeB = 8;
  const idxToRewrite = 9;
  const idxToDelete = 10;
  check('行索引定位正确',
    lines[idxUnique] === '灯光转暗。' &&
    lines[idxDupeA] === lines[idxDupeB] &&
    lines[idxToRewrite] === '列车进站。' &&
    lines[idxToDelete] === '大幕缓缓落下。');

  await req('POST', `/api/scripts/${sid}/cues`, { type: 'light', label: '暖光', lineIndex: idxUnique });
  await req('POST', `/api/scripts/${sid}/cues`, { type: 'sound', label: '雨声音效', lineIndex: idxDupeA });
  await req('POST', `/api/scripts/${sid}/cues`, { type: 'light', label: '月台蓝光', lineIndex: idxDupeB });
  await req('POST', `/api/scripts/${sid}/cues`, { type: 'sound', label: '火车轰鸣', lineIndex: idxToRewrite });
  await req('POST', `/api/scripts/${sid}/cues`, { type: 'light', label: '谢幕光', lineIndex: idxToDelete });

  // ---------- v2：两处重复台词上下文改成完全对称，另两句删除 ----------
  const v2 = [
    '第一场 车站',          // 0
    '林夏：有人吗？',        // 1
    '（雨声）',             // 2
    '周野：我等一个人。',    // 3
    '第二场 月台',          // 4
    '林夏：有人吗？',        // 5
    '（雨声）',             // 6
    '周野：我等一个人。',    // 7
    // 灯光转暗。 被删；列车进站。 被删
  ].join('\n');

  console.log('\n— 保存对称重复上下文版本（重复句无法区分 + 两句删除）—');
  const p2 = await req('PUT', `/api/scripts/${sid}`, { content: v2, note: '对称版' });
  check('版本号=2', p2.latestVersion.versionNo === 2);
  const by2 = Object.fromEntries(p2.cues.map((c) => [c.label, c]));

  check('对称重复台词 -> 待确认', by2['雨声音效'].status === 'pending',
    JSON.stringify({ s: by2['雨声音效'].status, r: by2['雨声音效'].pendingReason }));
  check('待确认候选恰好为两处重复位置',
    by2['雨声音效'].candidates.length === 2 &&
      by2['雨声音效'].candidates.every((c) => c.text === '周野：我等一个人。') &&
      by2['雨声音效'].candidates.map((c) => c.lineIndex).sort().join(',') === '3,7',
    JSON.stringify(by2['雨声音效'].candidates));
  check('待确认绝不挂到任何行(lineIndex=null)', by2['雨声音效'].lineIndex === null);
  check('待确认保留原锚点',
    by2['雨声音效'].anchor.text === '周野：我等一个人。' &&
    by2['雨声音效'].anchor.prev === '（雨声）' &&
    by2['雨声音效'].anchor.next === '灯光转暗。');
  check('另一处重复句同样待确认', by2['月台蓝光'].status === 'pending');
  check('删除的唯一句 -> 待确认', by2['暖光'].status === 'pending');
  check('删除的唯一句 -> 待确认(2)', by2['火车轰鸣'].status === 'pending');
  check('删除的唯一句 -> 待确认(3)', by2['谢幕光'].status === 'pending');
  check('没有任何提示被静默自动改挂',
    p2.cues.every((c) => c.status === 'pending'));

  // ---------- v3：恢复可区分上下文；唯一句移动；另一句删除 ----------
  const v3 = [
    '第一场 车站',          // 0
    '林夏：有人吗？',        // 1
    '（雨声）',             // 2
    '周野：我等一个人。',    // 3  ← 雨声音效应回到这里（雨声+灯光转暗 上下文）
    '灯光转暗。',           // 4  ← 暖光（唯一句，位置不变）
    '第二场 月台',          // 5
    '林夏：有人吗？',        // 6
    '（风声）',             // 7
    '周野：我等一个人。',    // 8  ← 月台蓝光（下一行被删，边界 + 风声唯一确定）
    '列车进站，鸣笛。',      // 9  ← 火车轰鸣原句的改写（模糊候选）
    // 大幕缓缓落下。 整句删除，且无相近行
  ].join('\n');

  console.log('\n— 保存常规改版（恢复上下文 / 移动 / 删除改写）—');
  const p3 = await req('PUT', `/api/scripts/${sid}`, { content: v3, note: '常规版' });
  check('版本号=3', p3.latestVersion.versionNo === 3);
  const by3 = Object.fromEntries(p3.cues.map((c) => [c.label, c]));

  check('唯一句保持原位 -> 自动绑定',
    by3['暖光'].status === 'bound' && by3['暖光'].lineIndex === 4 && by3['暖光'].autoMatched,
    JSON.stringify({ s: by3['暖光'].status, li: by3['暖光'].lineIndex }));
  check('重复台词+上下文可区分 -> 自动绑定到正确的一场',
    by3['雨声音效'].status === 'bound' && by3['雨声音效'].lineIndex === 3,
    JSON.stringify({ s: by3['雨声音效'].status, li: by3['雨声音效'].lineIndex }));
  check('边界+相邻行唯一确定 -> 自动绑定',
    by3['月台蓝光'].status === 'bound' && by3['月台蓝光'].lineIndex === 8,
    JSON.stringify({ s: by3['月台蓝光'].status, li: by3['月台蓝光'].lineIndex }));
  check('台词改写 -> 待确认且不自动改挂',
    by3['火车轰鸣'].status === 'pending' && by3['火车轰鸣'].lineIndex === null,
    by3['火车轰鸣'].pendingReason);
  check('改写句给出模糊候选',
    by3['火车轰鸣'].candidates.some((c) => c.lineIndex === 9),
    JSON.stringify(by3['火车轰鸣'].candidates));
  check('整句删除且无相近行 -> 待确认、无候选',
    by3['谢幕光'].status === 'pending' && by3['谢幕光'].candidates.length === 0,
    JSON.stringify(by3['谢幕光']));

  console.log('\n— 人工重新绑定（候选方式与手动方式）—');
  // 火车轰鸣：挂到模糊候选（改写后的句子，idx 9）
  const p4 = await req('POST', `/api/scripts/${sid}/cues/${by3['火车轰鸣'].id}/rebind`, { lineIndex: 9 });
  const rebound1 = p4.cues.find((c) => c.label === '火车轰鸣');
  check('候选绑定成功', rebound1.status === 'bound' && rebound1.lineIndex === 9);
  check('人工绑定不标自动、锚点更新',
    !rebound1.autoMatched && rebound1.anchor.text === '列车进站，鸣笛。' &&
    rebound1.anchor.prev === '周野：我等一个人。');

  // 谢幕光：无候选，从全剧行中手动指定绑定到“灯光转暗。”（idx 4）
  const p5 = await req('POST', `/api/scripts/${sid}/cues/${by3['谢幕光'].id}/rebind`, { lineIndex: 4 });
  const rebound2 = p5.cues.find((c) => c.label === '谢幕光');
  check('手动指定行绑定成功', rebound2.status === 'bound' && rebound2.lineIndex === 4);

  console.log('\n— 编辑 / 删除提示 —');
  const p6 = await req('PUT', `/api/scripts/${sid}/cues/${rebound2.id}`, {
    type: 'sound', label: '谢幕声效',
  });
  const edited = p6.cues.find((c) => c.id === rebound2.id);
  check('类型与内容已更新且绑定不受影响',
    edited.type === 'sound' && edited.label === '谢幕声效' &&
    edited.status === 'bound' && edited.lineIndex === 4);

  await req('DELETE', `/api/scripts/${sid}/cues/${rebound2.id}`);
  const p7 = await req('GET', `/api/scripts/${sid}`);
  check('删除生效', !p7.cues.some((c) => c.id === rebound2.id) && p7.cues.length === 4);
  check('仍在绑定的提示行文本正确返回',
    p7.cues.find((c) => c.label === '月台蓝光').lineText === '周野：我等一个人。');

  console.log('\n— 再次改版，人工/自动锚点继续参与定位 —');
  // 把第一场的雨声改成雷雨声：两处重复句中，第一场 prev 相似度更高（胜出>=0.12）
  const v4 = v3.replace('（雨声）', '（雷雨声）');
  const p8 = await req('PUT', `/api/scripts/${sid}`, { content: v4, note: '微调版' });
  const yu = p8.cues.find((c) => c.label === '雨声音效');
  check('一侧上下文决定性胜出 -> 自动绑定到第一场',
    yu.status === 'bound' && yu.lineIndex === 3,
    JSON.stringify({ s: yu.status, li: yu.lineIndex }));
  const yue = p8.cues.find((c) => c.label === '月台蓝光');
  check('第二场提示仍正确（边界+风声）',
    yue.status === 'bound' && yue.lineIndex === 8,
    JSON.stringify({ s: yue.status, li: yue.lineIndex }));

  console.log('\n— 版本历史（只读）—');
  const versions = await req('GET', `/api/scripts/${sid}/versions`);
  check('历史版本 4 个', versions.length === 4 && versions[0].version_no === 4);
  const v1detail = await req('GET', `/api/scripts/${sid}/versions/${versions[3].id}`);
  check('初版内容可回看', v1detail.content.includes('列车进站。') && v1detail.lines.length === 11);
  check('历史版本带版本号', v1detail.versionNo === 1);

  console.log('\n— 列表汇总状态 —');
  const list = await req('GET', '/api/scripts');
  const row = list.find((s) => s.id === sid);
  check('列表计数正确（4 条提示，0 待确认）',
    row.cue_total === 4 && row.cue_pending === 0, JSON.stringify(row));

  console.log('\n— 非法输入 —');
  await req('POST', `/api/scripts/${sid}/cues`, { type: 'nope', label: 'x', lineIndex: 0 })
    .then(() => check('非法类型被拒', false))
    .catch((e) => check('非法类型被拒', /light/.test(e.message)));
  await req('POST', `/api/scripts/${sid}/cues`, { type: 'light', label: '', lineIndex: 0 })
    .then(() => check('空内容被拒', false))
    .catch(() => check('空内容被拒', true));
  await req('POST', `/api/scripts/${sid}/cues`, { type: 'light', label: '越界', lineIndex: 9999 })
    .then(() => check('越界行号被拒', false))
    .catch(() => check('越界行号被拒', true));
  await req('PUT', `/api/scripts/${sid}`, { content: '   \n  ' })
    .then(() => check('空白新版本被拒', false))
    .catch(() => check('空白新版本被拒', true));
  await req('POST', '/api/scripts', { title: '', content: 'x' })
    .then(() => check('空标题被拒', false))
    .catch(() => check('空标题被拒', true));

  console.log(failures === 0 ? '\n全部通过 🎉' : `\n${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
