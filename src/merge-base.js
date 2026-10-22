// 求两个提交的最近公共祖先（合并基）。
//
// 这是 merge 的第一步，也是最容易做错的一步。
// 朴素做法：走完两个提交的全部祖先，取交集，再从中挑「最近的」。
// 难点在于「最近」——祖先图是 DAG，可能有多个互不支配的候选。
//
// 标准算法（git merge-base --all 的简化版）：
//   1. 用标记位从 A 向上遍历，标记所有祖先
//   2. 从 B 向上遍历，第一个遇到的「已标记」节点就是候选
//   3. 但要排除掉「候选的祖先」——那些更远的不能算
//
// 这里实现常见的「最佳公共祖先」：BFS 逐层推进，
// 找到深度最小的公共节点，并剔除其祖先。

import { readCommit } from "./commit.js";

// 收集某提交的全部祖先（含自身），返回 Map<oid, depth>
export async function ancestorMap(gitDir, startOid) {
  const map = new Map();
  const queue = [{ oid: startOid, depth: 0 }];
  while (queue.length > 0) {
    const { oid, depth } = queue.shift();
    if (!oid || map.has(oid)) continue;
    map.set(oid, depth);
    const commit = await readCommit(gitDir, oid);
    for (const parent of commit.parents) {
      if (!map.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return map;
}

// 找最近公共祖先。返回 oid 或 null（无共同历史）。
export async function findMergeBase(gitDir, oidA, oidB) {
  if (oidA === oidB) return oidA;

  const ancestorsA = await ancestorMap(gitDir, oidA);
  if (ancestorsA.has(oidB)) return oidB;   // B 是 A 的祖先
  const ancestorsB = await ancestorMap(gitDir, oidB);
  if (ancestorsB.has(oidA)) return oidA;   // A 是 B 的祖先

  // 两边都有的节点
  const common = [];
  for (const [oid, depth] of ancestorsA) {
    if (ancestorsB.has(oid)) {
      common.push({ oid, depth: depth + ancestorsB.get(oid) });
    }
  }
  if (common.length === 0) return null;

  // 按「总深度」升序：深度越小，离两个分支尖端越近。
  common.sort((a, b) => a.depth - b.depth);

  // 判据（这里曾写反过一次，产生过假冲突）：
  //   candidate 是最近公共祖先 ⟺ **不存在**其他公共祖先 X，
  //   使得 candidate 是 X 的祖先。
  //
  // 直觉：如果 candidate 还是某个更远节点的祖先，说明 candidate 本身更远，
  // 不该被选为「最近」。
  //
  // 反例（必须警惕）：若写成「X 是 candidate 的祖先就跳过 candidate」，
  // 就会跳过错的最优解——因为最近的节点当然拥有更多更远的祖先。
  const isAncestorOfAnother = async (candidate) => {
    for (const other of common) {
      if (other.oid === candidate.oid) continue;
      // 只可能被「更远」的节点所包含；近处的节点不可能是它的后代
      if (other.depth <= candidate.depth) continue;
      const otherAncestors = await ancestorMap(gitDir, other.oid);
      if (otherAncestors.has(candidate.oid)) return true;
    }
    return false;
  };

  // 总深度最小的候选基本就是答案；只在深度并列的少数情况下需要多验证几个。
  // 限制验证数量，避免在长历史仓库上退化成 O(V^2)。
  const limit = Math.min(common.length, 8);
  for (let i = 0; i < limit; i += 1) {
    if (!(await isAncestorOfAnother(common[i]))) return common[i].oid;
  }
  return common[0].oid;
}

export async function isAncestor(gitDir, maybeAncestor, descendant) {
  if (maybeAncestor === descendant) return true;
  const ancestors = await ancestorMap(gitDir, descendant);
  return ancestors.has(maybeAncestor);
}

// 快进判断：A 是 B 的祖先则可以快进
export async function canFastForward(gitDir, fromOid, toOid) {
  if (!fromOid) return true;
  return isAncestor(gitDir, fromOid, toOid);
}
