// dropwatch.js — safety net against last-minute OpenSea/dev config changes on a scheduled stage.
//
// Polls mint.fetchDrop(slug) for every pending schedule and diffs the live stage (matched by
// stageIndex) against what was saved when the schedule was created:
//   - price or max-per-wallet changed  -> CANCEL the schedule (money-at-risk change, needs a human)
//   - only start/end time changed      -> RESCHEDULE (re-arm timers to the new startMs/endMs)
//   - stage removed entirely           -> CANCEL
// Either way, a Telegram message is sent so it's never silent. STOP_BEFORE_MS =  berarti
// polling jalan terus sampe fire (fireSchedule marks 'fired' di baris pertama, jadi dropwatch
// ga pernah dobel check di saat yang sama. Perubahan detik-terakhir (dev/bot scheduled mint(
// ke-handle guard di fire path (lib/schedule.js readLiveConfig/configRisk(.const schedules = require('./schedules');
const mint = require('./mint');

// Same matcher as bot.js's matchStage(): OpenSea's stageIndex is positional and shifts when a
// stage is inserted earlier in the timeline (e.g. a new FCFS phase ahead of Public), so match on
// type (+label for non-public stages, since two signed stages can share a type) instead.
function matchStage(stages, s) {
  if (s.type === 'PUBLIC_SALE') {
    const byType = stages.find((x) => x.type === 'PUBLIC_SALE');
    if (byType) return byType;
  } else {
    const byTypeLabel = stages.find((x) => x.type === s.type && x.label === s.label);
    if (byTypeLabel) return byTypeLabel;
  }
  return stages.find((x) => x.index === s.stageIndex) || null;
}

const INTERVAL_MS = (Number(process.env.DROP_WATCH_INTERVAL_SEC) || 120) * 1000;
// Poll sampai fire sendiri (fireSchedule marks fired duluan, jadi ga dobel dobel. Default 0.
const STOP_BEFORE_MS = (Number(process.env.DROP_WATCH_STOP_BEFORE_SEC) || 0) * 1000;

const fmtEth = (v) => (v == null ? '?' : `${v} ETH`);

function diffStage(s, st) {
  if (!st) return { kind: 'removed' };
  const priceChanged = st.priceEth != null && Number(st.priceEth) !== Number(s.priceEth);
  const capChanged = st.maxPerWallet != null && Number(st.maxPerWallet) !== Number(s.maxPerWallet);
  if (priceChanged || capChanged) return { kind: 'risk', st, priceChanged, capChanged };
  const timeChanged = st.start !== s.startMs || st.end !== s.endMs;
  if (timeChanged) return { kind: 'time', st };
  return null;
}

async function checkOne(bot, s) {
  if (s.startMs - Date.now() <= STOP_BEFORE_MS) return; // prewarm/fire takes over from here
  let drop;
  try {
    drop = await mint.fetchDrop(s.slug);
  } catch (err) {
    console.error(`dropwatch ${s.collection} fetch failed:`, err.message);
    return;
  }
  if (!drop) return; // scrape miss; try again next tick, don't act on absence of data
  // matched by type(+label), not positional stageIndex — see bot.js matchStage() for why
  const st = matchStage(drop.stages, s);
  const diff = diffStage(s, st);
  if (!diff) return;

  if (diff.kind === 'removed') {
    schedules.cancel(s.id);
    bot.sendMessage(s.chatId, `Auto-mint CANCELLED: ${s.collection} — "${s.label}" stage no longer exists on OpenSea. Re-check the drop manually.`).catch(() => {});
    return;
  }
  if (diff.kind === 'risk') {
    const parts = [];
    if (diff.priceChanged) parts.push(`price ${fmtEth(s.priceEth)} -> ${fmtEth(diff.st.priceEth)}`);
    if (diff.capChanged) parts.push(`max/wallet ${s.maxPerWallet} -> ${diff.st.maxPerWallet}`);
    schedules.cancel(s.id);
    bot.sendMessage(
      s.chatId,
      `Auto-mint CANCELLED: ${s.collection} — "${s.label}" config changed (${parts.join(', ')}). ` +
        'Terminated instead of auto-adjusting since this affects cost. Re-schedule manually if you still want it.',
    ).catch(() => {});
    return;
  }
  // time-only change: safe to follow automatically
  const before = mint.fmtRangeWIB(s.startMs, s.endMs);
  const after = mint.fmtRangeWIB(diff.st.start, diff.st.end);
  schedules.reschedule(s.id, { startMs: diff.st.start, endMs: diff.st.end });
  bot.sendMessage(s.chatId, `Auto-mint RESCHEDULED: ${s.collection} — "${s.label}" time changed on OpenSea.\n${before} WIB -> ${after} WIB`).catch(() => {});
}

function start(bot) {
  setInterval(() => {
    for (const s of schedules.list()) {
      checkOne(bot, s).catch((err) => console.error(`dropwatch ${s.collection} error:`, err.message));
    }
  }, INTERVAL_MS);
  console.log(`dropwatch active: polling every ${INTERVAL_MS / 1000}s`);
}

module.exports = { start };
