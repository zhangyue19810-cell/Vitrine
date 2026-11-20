/**
 * Shared display limit for error lines. Full logs stay available through the
 * clipboard and the log folder; the on-screen surfaces stay scannable.
 */
export const MAX_LOG_ERRORS = 6;

const ERROR_LINE = /\b(ERROR|FATAL|SEVERE)\b|^\s*(Exception|java\.|Caused by:)|^\s+at [\w.$<>]+\(/;

export function isErrorLogLine(text: string): boolean {
  return ERROR_LINE.test(text);
}

/** Keep at most `max` failing lines and add one neutral explanation line. */
export function capErrorText(text: string, max = MAX_LOG_ERRORS): { text: string; hidden: number } {
  const lines = text.split(/\r?\n/);
  let errors = 0;
  let hidden = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (isErrorLogLine(line)) {
      if (errors >= max) {
        hidden++;
        continue;
      }
      errors++;
    }
    kept.push(line);
  }
  if (hidden) kept.push(`[Vitrine] 为保持可读性，只显示前 ${max} 条报错；其余 ${hidden} 条报错已折叠，完整日志可复制或打开日志文件夹查看。`);
  return { text: kept.join("\n"), hidden };
}
