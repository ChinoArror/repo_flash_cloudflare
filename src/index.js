const GITHUB_API = "https://api.github.com";
// 方便识别我们自己加的那一行，避免误删其他内容
const STAMP_PREFIX = "本周记录:";

export default {
  // 定时任务入口（cron）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateAllRepos(env));
  },

  // 可选：HTTP 触发，方便你手动测试
  async fetch(request, env, ctx) {
    const result = await updateAllRepos(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "content-type": "application/json;charset=utf-8" },
    });
  },
};

/**
 * 主逻辑：遍历所有仓库，更新 README
 */
async function updateAllRepos(env) {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("缺少 GITHUB_TOKEN，请在 Cloudflare Workers 中配置 Secret。");
  }

  const stampInfo = calcThisWeekStamp();
  const repos = await fetchAllRepos(token);

  const summary = [];

  for (const repo of repos) {
    const owner = repo.owner.login;
    const name = repo.name;

    try {
      const updated = await updateReadmeForRepo(token, owner, name, stampInfo);
      summary.push({
        repo: `${owner}/${name}`,
        status: updated ? "updated" : "skipped",
      });
    } catch (err) {
      summary.push({
        repo: `${owner}/${name}`,
        status: "error",
        error: String(err),
      });
    }
  }

  return { stampInfo, summary };
}

/**
 * 计算“本周日日期 + 年度第几周（ISO 周数）”
 */
function calcThisWeekStamp() {
  const now = new Date();

  // 计算「本周周日」：以当前日期为基准，找到同一周内的周日
  const sunday = new Date(now);
  const day = sunday.getUTCDay(); // 0=周日, 1=周一, ...
  // 找到接下来（或当天）的周日
  const diff = (7 - day) % 7;
  sunday.setUTCDate(sunday.getUTCDate() + diff);

  const year = sunday.getUTCFullYear();
  const month = String(sunday.getUTCMonth() + 1).padStart(2, "0");
  const date = String(sunday.getUTCDate()).padStart(2, "0");
  const sundayStr = `${year}-${month}-${date}`;

  const { isoYear, isoWeek } = getISOWeek(sunday);
  const stampText = `${STAMP_PREFIX} ${sundayStr} · ${isoYear}年第${isoWeek}周`;

  return { sundayStr, isoYear, isoWeek, stampText };
}

/**
 * ISO 周数计算
 */
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // 将日期调整到本周周四，ISO 周数定义使用周四所在的周
  const dayNum = d.getUTCDay() || 7; // 1-7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);

  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);

  return { isoYear, isoWeek: week };
}

/**
 * 拉取当前账号所有仓库（含私有，取决于 token 权限）
 */
async function fetchAllRepos(token) {
  let page = 1;
  const perPage = 100;
  const repos = [];

  while (true) {
    const url = `${GITHUB_API}/user/repos?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "cf-worker-weekly-stamp",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`获取仓库失败: ${res.status} ${text}`);
    }

    const batch = await res.json();
    repos.push(...batch);

    if (batch.length < perPage) break; // 没有下一页
    page++;
  }

  return repos;
}

/**
 * 针对单个仓库更新 README
 */
async function updateReadmeForRepo(token, owner, repo, stampInfo) {
  // 先获取 README 内容
  const readmeRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/readme`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cf-worker-weekly-stamp",
    },
  });

  if (readmeRes.status === 404) {
    // 没有 README 就跳过
    return false;
  }
  if (!readmeRes.ok) {
    const text = await readmeRes.text();
    throw new Error(`获取 README 失败: ${readmeRes.status} ${text}`);
  }

  const readmeData = await readmeRes.json();
  const sha = readmeData.sha;
  const path = readmeData.path; // 一般是 README.md

  const originalContent = fromBase64(readmeData.content);
  const newContent = applyStamp(originalContent, stampInfo.stampText);

  if (newContent === originalContent) {
    // 没有变化就不提交
    return false;
  }

  const updateRes = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "cf-worker-weekly-stamp",
      },
      body: JSON.stringify({
        message: `chore: update weekly stamp (${stampInfo.sundayStr})`,
        content: toBase64(newContent),
        sha,
      }),
    }
  );

  if (!updateRes.ok) {
    const text = await updateRes.text();
    throw new Error(`更新 README 失败: ${updateRes.status} ${text}`);
  }

  return true;
}

/**
 * 在 README 尾部插入 / 更新「本周记录」这一行
 */
function applyStamp(content, stampLine) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  if (lines.length === 0) {
    return stampLine + "\n";
  }

  let lastIndex = lines.length - 1;
  // 如果 README 末尾是空行，往前找非空行
  while (lastIndex >= 0 && lines[lastIndex].trim() === "") {
    lastIndex--;
  }

  // 原最后一行是我们的标记 -> 替换
  if (lastIndex >= 0 && lines[lastIndex].startsWith(STAMP_PREFIX)) {
    lines[lastIndex] = stampLine;
  } else {
    // 否则在末尾加上一行（保持原来的空行结构）
    lines.push(stampLine);
  }

  return lines.join("\n") + "\n";
}

/**
 * Base64 工具（支持 UTF-8）
 */
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}
