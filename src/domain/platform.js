const HOSTS = {
  xiaohongshu: new Set(["xiaohongshu.com", "www.xiaohongshu.com"]),
  instagram: new Set(["instagram.com", "www.instagram.com"]),
};

const INSTAGRAM_RESERVED_PATHS = new Set(["p", "reel", "reels", "stories", "explore", "accounts"]);

function parseSafeUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("请输入完整、安全的主页链接");
  }

  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password) {
    throw new Error("仅支持安全的 HTTPS 主页链接");
  }
  return parsed;
}

export function detectPlatform(input) {
  const parsed = parseSafeUrl(input);
  for (const [platform, hosts] of Object.entries(HOSTS)) {
    if (hosts.has(parsed.hostname.toLowerCase())) return platform;
  }
  throw new Error("仅支持小红书或 Instagram 主页链接");
}

export function normalizeProfileUrl(input) {
  const parsed = parseSafeUrl(input);
  const platform = detectPlatform(input);

  if (platform === "xiaohongshu") {
    const match = parsed.pathname.match(/^\/user\/profile\/([^/]+)\/?$/);
    if (!match) throw new Error("请输入小红书博主主页链接");
    return {
      platform,
      url: `https://www.xiaohongshu.com/user/profile/${encodeURIComponent(decodeURIComponent(match[1]))}`,
      profileKey: decodeURIComponent(match[1]),
    };
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  const profileKey = parts[0]?.toLowerCase();
  if (
    parts.length !== 1 ||
    !profileKey ||
    INSTAGRAM_RESERVED_PATHS.has(profileKey) ||
    !/^[a-z0-9._]+$/.test(profileKey)
  ) {
    throw new Error("请输入 Instagram 博主主页链接");
  }
  return {
    platform,
    url: `https://www.instagram.com/${profileKey}/`,
    profileKey,
  };
}
