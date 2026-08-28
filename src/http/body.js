export async function readBuffer(request, limit = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("请求内容过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(request, limit = 1_048_576) {
  const buffer = await readBuffer(request, limit);
  try {
    return JSON.parse(buffer.toString("utf8") || "{}");
  } catch {
    const error = new Error("请求内容不是有效 JSON");
    error.statusCode = 400;
    throw error;
  }
}
