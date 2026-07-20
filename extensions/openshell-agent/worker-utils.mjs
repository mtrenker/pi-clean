export function boundUtf8(value, bytes) {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  const marker = "\n\n[Answer truncated in host result]";
  const contentBytes = bytes - Buffer.byteLength(marker, "utf8");
  let result = value;
  while (Buffer.byteLength(result, "utf8") > contentBytes) {
    result = result.slice(0, Math.max(0, result.length - 256));
  }
  return `${result}${marker}`;
}
