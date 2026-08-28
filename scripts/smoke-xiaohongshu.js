import { pathToFileURL } from "node:url";

import { normalizeProfileUrl } from "../src/domain/platform.js";
import { parseProfilePayload } from "../src/collectors/xiaohongshu/parser.js";

function replaceUndefinedOutsideStrings(source) {
  let result = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      result += character;
      continue;
    }
    if (
      source.startsWith("undefined", index) &&
      !/[\w$]/.test(source[index - 1] ?? "") &&
      !/[\w$]/.test(source[index + 9] ?? "")
    ) {
      result += "null";
      index += 8;
      continue;
    }
    result += character;
  }
  return result;
}

export function extractInitialState(html) {
  const marker = "window.__INITIAL_STATE__=";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("页面没有公开的初始笔记数据");
  const contentStart = start + marker.length;
  const scriptEnd = html.indexOf("</script>", contentStart);
  if (scriptEnd < 0) throw new Error("页面初始数据不完整");
  const source = html.slice(contentStart, scriptEnd).trim().replace(/;$/, "");
  try {
    return JSON.parse(replaceUndefinedOutsideStrings(source));
  } catch {
    throw new Error("页面初始数据格式已经变化");
  }
}

export async function smokeProfile(input, fetchImpl = fetch) {
  const profile = normalizeProfileUrl(input);
  if (profile.platform !== "xiaohongshu") throw new Error("该冒烟检查只支持小红书主页");
  const response = await fetchImpl(profile.url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9",
    },
  });
  if (!response.ok) throw new Error(`主页访问失败：${response.status ?? "未知状态"}`);
  const parsed = parseProfilePayload(extractInitialState(await response.text()));
  const usableIds = parsed.items.filter((item) => item.id).length;
  return {
    author: parsed.author,
    visibleCards: parsed.items.length,
    usableIds,
    requiresLogin: parsed.items.length > 0 && usableIds === 0,
  };
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("请提供小红书公开博主主页链接");
  const result = await smokeProfile(input);
  console.log(`博主：${result.author || "页面未公开"}`);
  console.log(`首屏笔记：${result.visibleCards}`);
  console.log(`可用笔记编号：${result.usableIds}`);
  console.log(result.requiresLogin ? "状态：等待人工登录或验证" : "状态：公开主页读取正常");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`冒烟检查失败：${error.message}`);
    process.exitCode = 1;
  });
}
