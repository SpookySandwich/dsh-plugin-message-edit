/** Normalize DSH's live sessions and query snapshots at the host boundary. */
export function sessionEvents(session) {
  const events = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : session?.events;
  if (!Array.isArray(events)) {
    throw new Error('无法读取 DSH 会话历史：需要 snapshotEvents() 或 events 数组，请检查插件与 DSH 的版本兼容性。');
  }
  return events;
}

/** Read the append-only log length without materializing a modern live log. */
export function sessionEventCount(session) {
  return typeof session?.snapshotEvents === 'function' && Number.isSafeInteger(session.seq) && session.seq >= 0
    ? session.seq
    : sessionEvents(session).length;
}

/** One stable snapshot for all planning, ancestry, and seed reads in an operation. */
export function sessionRecord(session) {
  const events = sessionEvents(session);
  const header = session.header ?? session.session;
  if (!header || typeof header.id !== 'string') throw new Error('无法读取 DSH 会话头：缺少会话标识。');
  const inheritedEventCount = session.inheritedEventCount ?? header.seedLength
    ?? (header.isSeeded === true ? undefined : 0);
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0 || inheritedEventCount > events.length) {
    throw new Error(`会话 ${header.id} 的继承事件边界无效，无法安全创建分支。`);
  }
  return { id: header.id, header, events, inheritedEventCount };
}

/** DSH moved the inherited cut from header.seedLength to a creation option. */
export function branchSeedOptions(source, inheritedEventCount) {
  return typeof source.header.isSeeded === 'boolean'
    ? { inheritedEventCount, meta: { isSeeded: true } }
    : { meta: { seedLength: inheritedEventCount } };
}
