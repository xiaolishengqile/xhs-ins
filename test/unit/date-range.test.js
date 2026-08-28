import test from "node:test";
import assert from "node:assert/strict";

import { resolveDateRange } from "../../src/domain/date-range.js";

test("最近一周包含当天在内共七个自然日", () => {
  const result = resolveDateRange({ preset: "week" }, new Date(2026, 7, 28, 15, 20));
  const from = new Date(result.from);
  const to = new Date(result.to);

  assert.deepEqual([from.getFullYear(), from.getMonth(), from.getDate(), from.getHours()], [2026, 7, 22, 0]);
  assert.deepEqual([to.getFullYear(), to.getMonth(), to.getDate(), to.getHours(), to.getMinutes()], [2026, 7, 28, 23, 59]);
});

test("最近一个月按日历月计算并处理月底", () => {
  const result = resolveDateRange({ preset: "month" }, new Date(2026, 2, 31, 12));
  const from = new Date(result.from);

  assert.deepEqual([from.getFullYear(), from.getMonth(), from.getDate()], [2026, 1, 28]);
});

test("最近一年按十二个日历月计算并处理闰日", () => {
  const result = resolveDateRange({ preset: "year" }, new Date(2024, 1, 29, 12));
  const from = new Date(result.from);
  const to = new Date(result.to);

  assert.deepEqual([from.getFullYear(), from.getMonth(), from.getDate(), from.getHours()], [2023, 1, 28, 0]);
  assert.deepEqual([to.getFullYear(), to.getMonth(), to.getDate(), to.getHours(), to.getMinutes()], [2024, 1, 29, 23, 59]);
});

test("自定义日期覆盖完整起止日", () => {
  const result = resolveDateRange({ preset: "custom", from: "2026-01-02", to: "2026-02-03" });
  const from = new Date(result.from);
  const to = new Date(result.to);

  assert.deepEqual([from.getMonth(), from.getDate(), from.getHours()], [0, 2, 0]);
  assert.deepEqual([to.getMonth(), to.getDate(), to.getHours(), to.getMinutes(), to.getSeconds()], [1, 3, 23, 59, 59]);
});

test("拒绝颠倒或不完整的自定义日期", () => {
  assert.throws(
    () => resolveDateRange({ preset: "custom", from: "2026-02-03", to: "2026-01-02" }),
    /开始日期不能晚于结束日期/,
  );
  assert.throws(() => resolveDateRange({ preset: "custom", from: "2026-02-03" }), /完整/);
});
