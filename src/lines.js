'use strict';

/**
 * 台词行解析与提示重新定位。
 *
 * 行规则：按换行切分，去除整行空白；保留空行之外的全部内容（角色名、舞台提示、
 * 场景标题等都可以作为相邻上下文），不做任何会改变语义的截断。
 */

/** 把剧本文本解析成行数组（去空白行，每行 trim） */
function parseLines(content) {
  if (typeof content !== 'string') return [];
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 比较用的归一化文本：折叠连续空白，不改变文字，以容忍无关空格差异 */
function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
}

function contextOf(lines, idx) {
  return {
    text: lines[idx],
    prev: idx > 0 ? lines[idx - 1] : null,
    next: idx < lines.length - 1 ? lines[idx + 1] : null,
  };
}

/** Levenshtein 编辑距离 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // 插入
        prev[j] + 1, // 删除
        prev[j - 1] + cost // 替换
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/** 0~1 相似度 */
function similarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * 上下文匹配评分：锚点的上/下相邻行与候选位置实际相邻行的相似度之和。
 * null 一侧（锚点原本就在首/末行）只有对应侧同为 null 才给满分，否则不给分。
 */
function contextScore(candidateCtx, anchorPrev, anchorNext) {
  let score = 0;
  let sides = 0;

  if (anchorPrev != null) {
    sides += 1;
    score += candidateCtx.prev == null ? 0 : similarity(candidateCtx.prev, anchorPrev);
  } else if (candidateCtx.prev == null) {
    score += 1;
    sides += 1;
  }

  if (anchorNext != null) {
    sides += 1;
    score += candidateCtx.next == null ? 0 : similarity(candidateCtx.next, anchorNext);
  } else if (candidateCtx.next == null) {
    score += 1;
    sides += 1;
  }

  return sides === 0 ? 0 : score / sides;
}

/**
 * 依据锚点在新版本行数组中重新定位一条提示。
 *
 * 返回：
 *  { status: 'bound', lineIndex, autoMatched, matchType, ... }   可高置信自动绑定
 *  { status: 'pending', reason, candidates:[{lineIndex,text,score}] } 无法唯一定位
 *
 * 原则：重复台词不能由上下文唯一区分、或原句已删除（仅剩模糊候选）时，
 * 一律 pending，绝不静默挂到另一句上。
 */
function boundResult(lineIndex, matchType, newLines, anchor) {
  return {
    status: 'bound',
    lineIndex,
    autoMatched: true,
    matchType,
    contextScore: contextScore(contextOf(newLines, lineIndex), anchor.prev, anchor.next),
  };
}

function relocateCue(anchor, newLines) {
  const anchorText = normalize(anchor.text);

  if (newLines.length === 0) {
    return {
      status: 'pending',
      reason: '新版本为空，无法定位原台词',
      candidates: [],
    };
  }

  // 1) 在新版本中找出所有与锚点台词完全一致的位置
  const exact = [];
  for (let i = 0; i < newLines.length; i++) {
    if (normalize(newLines[i]) === anchorText) exact.push(i);
  }

  if (exact.length === 1) {
    // 唯一命中：直接绑定（上下文作为置信记录，不改变自动绑定结果）
    return {
      status: 'bound',
      lineIndex: exact[0],
      autoMatched: true,
      matchType: 'unique_exact',
      contextScore: contextScore(contextOf(newLines, exact[0]), anchor.prev, anchor.next),
    };
  }

  if (exact.length > 1) {
    // 多句相同台词：用相邻行上下文消歧
    const anchorPrevN = normalize(anchor.prev);
    const anchorNextN = normalize(anchor.next);
    const scored = exact.map((i) => {
      const ctx = contextOf(newLines, i);
      const prevN = normalize(ctx.prev);
      const nextN = normalize(ctx.next);
      return { lineIndex: i, ctx, prevN, nextN };
    });

    // 逐条判断每一侧（上一行 / 下一行）是否“决定性吻合”：
    //  - 边界侧（锚点该侧为 null）：只有同样在边界的候选吻合，且边界位置唯一
    //  - 文本侧：该候选相似度 >= 0.6，且严格高于其他所有候选（胜出差 >= 0.12）
    function sideDecides(key, normVal, boundary) {
      if (boundary) {
        const onBoundary = scored.filter((s) => (s[key] === ''));
        return onBoundary.length === 1 ? onBoundary[0] : null;
      }
      let best = null;
      for (const s of scored) {
        const sim = s[key] === '' ? 0 : similarity(s[key], normVal);
        s.sim = s.sim || {};
        s.sim[key] = sim;
        if (!best || sim > best.sim[key]) best = s;
      }
      if (!best || best.sim[key] < 0.6) return null;
      const others = scored.filter((s) => s !== best);
      if (others.some((s) => best.sim[key] - s.sim[key] < 0.12)) return null;
      return best;
    }

    const byPrev = sideDecides('prevN', anchorPrevN, anchor.prev == null);
    const byNext = sideDecides('nextN', anchorNextN, anchor.next == null);

    if (byPrev && byNext) {
      if (byPrev.lineIndex === byNext.lineIndex) {
        return boundResult(byPrev.lineIndex, 'context_disambiguated', newLines, anchor);
      }
    } else if (byPrev || byNext) {
      // 只有一侧可用（另一侧锚点缺失或无法判），该侧唯一决定性命中即可
      return boundResult((byPrev || byNext).lineIndex, 'context_disambiguated', newLines, anchor);
    }

    // 上下文无法唯一区分（并列 / 都不相似）——必须人工确认
    const withScores = scored.map((s) => ({
      lineIndex: s.lineIndex,
      score: contextScore(s.ctx, anchor.prev, anchor.next),
    }));
    const max = Math.max(...withScores.map((s) => s.score));
    return {
      status: 'pending',
      reason:
        max < 0.6
          ? '该台词在新剧本中出现多次，且相邻行与原上下文均不吻合，无法确定是哪一句'
          : '该台词在新剧本中出现多次，相邻行上下文相同或过于接近，无法唯一确定',
      candidates: withScores
        .map((s) => ({ lineIndex: s.lineIndex, text: newLines[s.lineIndex], score: s.score }))
        .sort((a, b) => b.score - a.score),
    };
  }

  // 2) 完全一致的台词已不存在（被删/改写）：只给模糊候选，不自动绑定
  const fuzzy = [];
  for (let i = 0; i < newLines.length; i++) {
    const textScore = similarity(newLines[i], anchorText);
    if (textScore >= 0.6) {
      const ctxScore = contextScore(contextOf(newLines, i), anchor.prev, anchor.next);
      fuzzy.push({
        lineIndex: i,
        text: newLines[i],
        score: Math.round(textScore * 100) / 100,
        contextScore: Math.round(ctxScore * 100) / 100,
      });
    }
  }
  fuzzy.sort((a, b) => b.score - a.score || b.contextScore - a.contextScore);

  return {
    status: 'pending',
    reason: '原锚点台词在新剧本中已找不到完全一致的行（可能已删除或改写），请人工确认是否改挂到相近台词',
    candidates: fuzzy.slice(0, 5),
  };
}

module.exports = { parseLines, normalize, similarity, contextOf, relocateCue };
