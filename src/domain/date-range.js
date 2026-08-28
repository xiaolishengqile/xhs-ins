const PRESET_MONTHS = { month: 1, halfYear: 6 };

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(value) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function subtractMonthsClamped(value, months) {
  const date = new Date(value);
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDay));
  return date;
}

function parseDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) throw new Error("请输入完整的自定义日期");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error("请输入有效日期");
  }
  return date;
}

export function resolveDateRange(input, now = new Date()) {
  let from;
  let to;

  if (input?.preset === "custom") {
    from = startOfDay(parseDateOnly(input.from));
    to = endOfDay(parseDateOnly(input.to));
  } else {
    to = endOfDay(now);
    from = startOfDay(now);
    if (input?.preset === "week") from.setDate(from.getDate() - 6);
    else if (PRESET_MONTHS[input?.preset]) from = startOfDay(subtractMonthsClamped(from, PRESET_MONTHS[input.preset]));
    else throw new Error("请选择有效的采集周期");
  }

  if (from > to) throw new Error("开始日期不能晚于结束日期");
  return { from: from.toISOString(), to: to.toISOString() };
}
