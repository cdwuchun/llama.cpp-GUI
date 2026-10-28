/**
 * 下拉选项文案拆成「左栏名字 + 右栏小字」。
 *
 * 参数的取值定义里习惯把解释塞进全角括号（`int8（省一半显存）`），而右边那栏又重复
 * 显示取值本身（`int8`）—— 一条选项两处讲同一件事，还把名字挤得只剩半个。
 * 这里把括注拆出来当右栏副文本：左栏只留名字（`int8`），右栏写解释（`省一半显存`）；
 * 没有括注的项右栏退回显示取值（`32K` 右边是 `32768`），取值与名字完全相同时留空。
 */
const TRAILING_PAREN = /^(.*?)\s*[（(]\s*([^（()）]*?)\s*[)）]\s*$/;

export function splitOptionText(
  label: string,
  value: string,
): { name: string; sub: string } {
  const hit = TRAILING_PAREN.exec(label);
  if (hit && hit[1].trim()) return { name: hit[1].trim(), sub: hit[2].trim() };
  return { name: label, sub: value === label ? "" : value };
}
