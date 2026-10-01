// ---- Schedule management + auto-mint firing ----
// bot.js: const scheduleMod = require('./lib/schedule')({ bot, sessionStore, schedules, mint,
//   ethers, providers, fastmint, walletAddresses, endAndReturnToMenu, shortAddr, runMint,
//   prepareMint, refreshPrep, estimateGasCost });

module.exports = ({ bot, sessionStore, schedules, mint, ethers, providers, fastmint, walletAddresses, endAndReturnToMenu, shortAddr, runMint, prepareMint, refreshPrep, estimateGasCost, defaultGasLimit }) => {
  // ---- Manage scheduled mints ----

  const SCHED_MIN_LABEL = (s) => `${s.collection.split(' ')[0]}-${(s.label || '?').slice(0, 14)}`;

  function renderScheduleList(chatId, session) {
    const pending = schedules.list();
    session.step = 'schedule_manage_list';
    sessionStore.setSession(chatId, session, bot);
    if (pending.length === 0) {
      return bot.sendMessage(chatId, 'No active scheduled mint.\n\nCreate one: Mint → paste CA → [Set schedule mint]', {
        reply_markup: { inline_keyboard: [[{ text: 'Menu', callback_data: 'menu_home' }]] },
      });
    }
    const now = Date.now();
    const lines = pending.map((s) => {
      const mins = Math.round((s.startMs - now) / 60000);
      const when = mins > 0 ? `in ${mins < 60 ? mins + 'm' : Math.round(mins / 60) + 'h'}` : 'FIRING SOON';
      return `${SCHED_MIN_LABEL(s)} — ${when}`;
    });
    bot.sendMessage(chatId, `Scheduled mints (${pending.length}):\n${lines.join('\n')}`, {
      reply_markup: {
        inline_keyboard: [
          ...pending.map((s) => [{ text: SCHED_MIN_LABEL(s), callback_data: `schd_${s.id}` }]),
          [{ text: 'Menu', callback_data: 'menu_home' }],
        ],
      },
    });
  }

  function renderScheduleDetail(chatId, session, s) {
    const now = Date.now();
    const mins = Math.round((s.startMs - now) / 60000);
    session.step = 'schedule_manage_detail';
    session.data.schdId = s.id;
    sessionStore.setSession(chatId, session, bot);
    const total = ethers.parseEther(String(s.priceEth ?? 0)) * BigInt(s.qty) * BigInt(s.wallets.length);
    bot.sendMessage(
      chatId,
      `${SCHED_MIN_LABEL(s)} (#${s.id})\n${s.collection} — ${s.label}\n${mint.fmtRangeWIB(s.startMs, s.endMs)} WIB\nMint: ${s.wallets.length} wallet × ${s.qty} @ ${s.priceEth} ETH = ${ethers.formatEther(total)} ETH + gas\n\nFires in ${mins} minute(s).`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '⟳ Refresh', callback_data: `schd_${s.id}` },
              { text: 'Change max mint', callback_data: 'schd_qty' },
            ],
            [{ text: 'All wallet', callback_data: 'schd_wallets' }],
            [{ text: 'Close', callback_data: 'schd_close' }],
            [{ text: 'Menu', callback_data: 'menu_home' }],
          ],
        },
      },
    );
  }

  function renderSchdWallets(chatId, session) {
    const s = schedules.list().find((x) => x.id === session.data.schdId);
    if (!s) return endAndReturnToMenu(chatId, 'Schedule already fired/cancelled.');
    const lines = s.wallets.map((i, k) => `${k + 1}. ${shortAddr(walletAddresses[i])} × ${s.qty}`).join('\n');
    session.step = 'schedule_manage_detail';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, `${SCHED_MIN_LABEL(s)} — wallets (${s.wallets.length}):\n${lines}`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Back', callback_data: `schd_${s.id}` }],
          [{ text: 'Menu', callback_data: 'menu_home' }],
        ],
      },
    });
  }

  function showScheduleList(chatId, session) {
    session = session || { flow: 'manage', step: '', data: {} };
    session.flow = 'manage';
    session.data = session.data || {};
    renderScheduleList(chatId, session);
  }

  function showScheduleDetail(chatId, session, id) {
    const s = schedules.list().find((x) => x.id === id);
    if (!s) return endAndReturnToMenu(chatId, 'Schedule not found or already fired/cancelled.');
    session.flow = 'manage';
    session.data = session.data || {};
    renderScheduleDetail(chatId, session, s);
  }

  // ---- Schedule auto-mint ----

  const SCH_PAGE = 5;

  function schUpcomingStages(drop, elig) {
    const now = Date.now();
    const schedulable = new Set((elig || []).filter((e) => e.count > 0).map((e) => e.stage.index));
    return drop.stages
      .filter((s) => s.start > now && (s.type === 'PUBLIC_SALE' || schedulable.has(s.index)))
      .sort((a, b) => a.start - b.start);
  }

  async function enterScheduleMenu(chatId, session) {
    const drop = session.data.drop;
    const upcoming = schUpcomingStages(drop, session.data.stageElig);
    if (upcoming.length === 0) {
      return endAndReturnToMenu(chatId, 'No upcoming stage with an eligible wallet to schedule.');
    }
    if (upcoming.length > 1) {
      session.step = 'sch_stage_pick';
      sessionStore.setSession(chatId, session, bot);
      return bot.sendMessage(chatId, 'Which stage?', {
        reply_markup: {
          inline_keyboard: [
            ...upcoming.map((s) => [{ text: `${s.label} — ${mint.fmtRangeWIB(s.start, s.end)} WIB`, callback_data: `stage_${s.index}` }]),
            [{ text: 'Menu', callback_data: 'menu_home' }],
          ],
        },
      });
    }
    return enterSchWalletMenu(chatId, session, upcoming[0]);
  }

  // reasons per stage: OS matrix, pseudo-all-ok for public, else null
  function stageReasons(session, stage) {
    const e = (session.data.stageElig || []).find((x) => x.stage.index === stage.index);
    if (e && e.reasons) return e.reasons;
    if (e && e.note === 'public, schedulable') return walletAddresses.map((a) => ({ minter: a, ok: true }));
    return null;
  }

  async function enterSchWalletMenu(chatId, session, stage) {
    session.data.schStage = stage;
    session.data.schSel = [];
    const eligReasons = stageReasons(session, stage);
    const eligCount = eligReasons ? eligReasons.filter((r) => r.ok).length : null;
    const eligLine = eligCount != null
      ? `${eligCount}/${walletAddresses.length} eligible${eligCount ? ' — tap [Elig wallet]' : ''}`
      : `${walletAddresses.length} wallet ready (balance > 0). Eligibility re-checked at execution.`;
    session.step = 'sch_menu';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(
      chatId,
      `Stage: ${stage.label}\n${mint.fmtRangeWIB(stage.start, stage.end)} WIB, ${stage.priceEth} ETH, max ${stage.maxPerWallet ?? '?'}/wallet\n${eligLine}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Bulk-mint', callback_data: 'sch_bulk' },
              { text: 'Separate-mint', callback_data: 'sch_sep' },
            ],
            [
              { text: 'Elig wallet', callback_data: 'sch_elig' },
              { text: 'See all wallet', callback_data: 'sch_seeall' },
              { text: 'Menu', callback_data: 'menu_home' },
            ],
          ],
        },
      },
    );
  }

  function renderSchElig(chatId, session) {
    const stage = session.data.schStage;
    const reasons = stageReasons(session, stage);
    const lines = reasons
      ? reasons.map((r, i) => `${i + 1}. ${r.minter}${r.ok ? ' ✓ eligible' : ' ✗'}`).join('\n')
      : walletAddresses.map((a, i) => `${i + 1}. ${a} (eligibility re-checked at execution)`).join('\n');
    session.step = 'schedule_seeall';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, `Eligibility — ${stage.label}:\n${lines}`, {
      reply_markup: {
        inline_keyboard: [[{ text: 'Back', callback_data: 'sch_back' }]],
      },
    });
  }

  function renderSchSepPage(chatId, session) {
    const sel = session.data.schSel;
    const page = session.data.schPage;
    const start = page * SCH_PAGE;
    const slice = walletAddresses.slice(start, start + SCH_PAGE);
    const lines = slice.map((a, i) => {
      const idx = start + i;
      return `${idx + 1}. ${shortAddr(a)}${sel.includes(idx) ? ' [x]' : ''}`;
    });
    const more = walletAddresses.length - start - slice.length;
    if (more > 0) lines.push(`+${more} more...`);
    const pages = Math.ceil(walletAddresses.length / SCH_PAGE);
    const stage = session.data.schStage;
    session.step = 'schedule_sep';
    sessionStore.setSession(chatId, session, bot);
    const nav = pages > 1
      ? [[
          ...(page > 0 ? [{ text: '<-', callback_data: 'schp_prev' }] : []),
          { text: `${page + 1}/${pages}`, callback_data: 'schp_noop' },
          ...(page < pages - 1 ? [{ text: '->', callback_data: 'schp_next' }] : []),
        ]]
      : [];
    bot.sendMessage(
      chatId,
      `Which wallet? (tap number keys below, or type numbers like 1, 7, 8)\n${lines.join('\n')}\n\nSelected: ${sel.length > 0 ? sel.map((i) => i + 1).join(',') : 'none'}`,
      {
        reply_markup: {
          inline_keyboard: [
            ...nav,
            [{ text: `Done (${sel.length} selected)`, callback_data: 'schp_done' }],
            [{ text: 'Menu', callback_data: 'menu_home' }],
          ],
        },
      },
    );
  }

  function renderSchSeeAll(chatId, session) {
    const page = session.data.schPage;
    const start = page * 8;
    const slice = walletAddresses.slice(start, start + 8);
    const lines = slice.map((a, i) => `${start + i + 1}. ${a}`).join('\n');
    const pages = Math.ceil(walletAddresses.length / 8);
    session.step = 'schedule_seeall';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, `All wallets (${page + 1}/${pages}):\n${lines}`, {
      reply_markup: {
        inline_keyboard: [
          [
            ...(page > 0 ? [{ text: '<-', callback_data: 'see_prev' }] : []),
            ...(page < pages - 1 ? [{ text: '->', callback_data: 'see_next' }] : []),
          ],
          [{ text: 'Back', callback_data: 'sch_back' }],
        ],
      },
    });
  }

  async function askSchQty(chatId, session) {
    const max = session.data.schStage.maxPerWallet ?? 100;
    if (max <= 1) {
      session.data.schQty = 1;
      return schConfirm(chatId, session);
    }
    session.step = 'schedule_qty';
    sessionStore.setSession(chatId, session, bot);
    bot.sendMessage(chatId, `How many per wallet? (1-${max})`);
  }

  async function schConfirm(chatId, session) {
    const sel = session.data.schSel;
    const stage = session.data.schStage;
    const qty = session.data.schQty;
    const priceWei = ethers.parseEther(String(stage.priceEth ?? 0));
    const total = priceWei * BigInt(qty) * BigInt(sel.length);
    session.step = 'schedule_confirm';
    sessionStore.setSession(chatId, session, bot);

    // Estimated gas across ALL wallets in this schedule (each fires its own tx), from LIVE fee
    // data right now — will drift some by the time the stage actually opens, but gives a real
    // number instead of the old silent "+ gas". If a cap is set (MINT_MAX_GAS_ETH[_CHAIN]) and
    // today's fee market would already exceed it, say so up front instead of scheduling something
    // that's just going to get silently skipped at fire time.
    const gasLimit = defaultGasLimit(qty, session.data.chainInput);
    let gasLine = 'Gas: unable to estimate right now (shown as "?" — will still be checked live at fire time)';
    try {
      const est = await estimateGasCost({ chainInput: session.data.chainInput, gasLimit });
      if (est) {
        const n = BigInt(sel.length);
        const likelyAll = est.likelyEth * sel.length;
        const worstAll = est.worstCaseEth * sel.length;
        gasLine = `Gas (${sel.length} wallet${sel.length > 1 ? 's' : ''}, right now): ~${likelyAll.toFixed(6)} ETH likely, up to ${worstAll.toFixed(6)} ETH worst-case (tip ${est.tipGwei.toFixed(2)} gwei, base ${est.baseFeeGwei.toFixed(2)} gwei)`;
        if (est.capEth != null && est.worstCaseEth > est.capEth) {
          gasLine += `\n⚠️ Your gas cap is ${est.capEth} ETH/tx — at today's fees this would be SKIPPED, not fired, unless fees drop before the stage opens.`;
        }
      }
    } catch (err) {
      console.error('schConfirm gas estimate failed:', err.message);
    }

    bot.sendMessage(
      chatId,
      `--- Schedule Mint ---\n${session.data.collection} — ${stage.label}\n${mint.fmtRangeWIB(stage.start, stage.end)} WIB\nPrice: ${stage.priceEth} ETH × ${qty}/wallet\nWallets: ${sel.length}\nTotal: ${ethers.formatEther(total)} ETH + gas\n${gasLine}\n\nBot fires automatically when the stage opens. Gas is re-checked live at that time — this is today's estimate, not a lock-in.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Yes schedule', callback_data: 'sch_confirm_yes' },
            { text: 'Menu', callback_data: 'menu_home' },
          ]],
        },
      },
    );
  }

  // Match a saved schedule to its live stage without relying on positional stageIndex, which
  // shifts when OpenSea/the dev inserts a new stage earlier in the drop timeline (e.g. a new
  // FCFS phase added ahead of Public). PUBLIC_SALE is matched by type alone (a drop has at most
  // one). Non-public stages are matched by type+label, since two signed stages can share a type.
  // Falls back to stageIndex only if no type/label match is found (older schedules / edge cases).
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

  // Prewarm state per schedule: { promise, prep, priceWei, seadrop }.

    const prewarmed = new Map();

    async function readUint(provider, ca, sel) {
      try {
        const data = await provider.call({ to: ca, data: sel });
        if (!data || data === '0x' || data.length < 66) return null;
        return BigInt(data);
      } catch { return null; }
    }


    // Sold-out guard: kalau totalSupply >= maxSupply (abis di phase FCFS dll) → cancel schedule+notif, biar ga fire percuma.

    async function soldOutGuard(s) {
      const provider = providers[s.chain];
      if (!provider) return false;
      const max = await readUint(provider, s.ca, '0xd5abeb01');
      // maxSupply ga ada (bukan SeaDrop at nggak kena) at 0 = ga tau cap → jangan cancel buta
      if (max == null || max === 0n) return false;
      const sup = await readUint(provider, s.ca, '0x18160ddd');
      if (sup == null || sup < max) return false;
      schedules.cancel(s.id);
      prewarmed.delete(s.id);
      bot.sendMessage(s.chatId, `🔔 ${s.collection} — sold out (${sup.toString()}/${max.toString()}) at ${new Date().toLocaleTimeString()}. Schedule auto-cancelled, ga usah cancel manual.`).catch(() => {});
      return true;
    }


    async function prewarmSchedule(s) {
      const provider = providers[s.chain];
      if (!provider) return;
      if (await soldOutGuard(s)) return;
    const entry = { promise: null, prep: null, priceWei: null, seadrop: null };
    prewarmed.set(s.id, entry);
    entry.promise = (async () => {
      // re-read the live stage price + on-chain SeaDrop recon now, off the hot path
      const [drop, seadrop] = await Promise.all([
        mint.fetchDrop(s.slug).catch(() => null),
        mint.detectSeadrop(provider, s.ca).catch(() => null),
      ]);
      let priceWei = ethers.parseEther(String(s.priceEth));
      const st = drop && matchStage(drop.stages, s);
      if (st && st.priceEth != null) priceWei = ethers.parseEther(String(st.priceEth));
      entry.priceWei = priceWei;
      entry.seadrop = seadrop;
      entry.prep = await prepareMint({
        chainInput: s.chain, ca: s.ca, mintSig: s.mintSig, mintName: s.mintName,
        priceWei, qty: s.qty, indexes: s.wallets, seadrop, slug: s.slug,
      });
      console.log(`prewarm ${s.collection}: route=${entry.prep.route}, ${s.wallets.length} wallet(s) ready`);
    })().catch((err) => {
      entry.prep = null;
      console.error(`prewarm ${s.collection} failed (fire will run cold):`, err.message);
    });
    await entry.promise;
  }

  async function refreshSchedule(s) {
    if (await soldOutGuard(s)) return;
    const entry = prewarmed.get(s.id);
    if (!entry) return;
    await entry.promise;
    if (entry.prep) await refreshPrep(entry.prep).catch((err) => console.error(`refresh ${s.collection} failed:`, err.message));
  }

  async function fireSchedule(s) {
    const tEnter = Date.now();
    schedules.mark(s.id, 'fired');
    const provider = providers[s.chain];
    if (!provider) return bot.sendMessage(s.chatId, `Auto-mint ${s.collection}: no RPC for ${s.chain}, aborting`);
    const entry = prewarmed.get(s.id);
    prewarmed.delete(s.id);
    // armed late and prewarm still running: give it a moment instead of starting a second cold prep
    if (entry && !entry.prep) await Promise.race([entry.promise, fastmint.sleep(3000)]);
    let prep = entry && entry.prep && Date.now() - entry.prep.preparedAt < 90000 ? entry.prep : null;
    let priceWei = entry && entry.priceWei != null ? entry.priceWei : ethers.parseEther(String(s.priceEth));
    let seadrop = entry ? entry.seadrop : null;
    if (!prep) {
      // cold path (no/failed/stale prewarm): same lookups as before but in parallel, not serial
      const [drop, sd] = await Promise.all([
        mint.fetchDrop(s.slug).catch(() => null),
        mint.detectSeadrop(provider, s.ca).catch(() => null),
      ]);
      const st = drop && matchStage(drop.stages, s);
      if (st && Date.now() >= st.start && Date.now() <= st.end && st.priceEth != null) priceWei = ethers.parseEther(String(st.priceEth));
      seadrop = sd;
    }
    try {
      const run = runMint(provider, s.chain, s.ca, s.collection, s.mintSig, s.mintName, priceWei, s.qty, s.wallets, s.label, s.chatId, seadrop || null, prep, s.slug);
      // announce AFTER the sends are in flight so Telegram never sits in front of the broadcast
      bot.sendMessage(s.chatId, `Auto-mint ${s.collection} — "${s.label}" is open! Firing ${s.wallets.length} wallet(s) × ${s.qty}...`).catch(() => {});
      const out = await run;
      // timing vs stage open (T = s.startMs), same VPS clock as the timers. Diagnostic only.
      const sentAts = out.results.map((r) => r.sentAt).filter((v) => v != null);
      const rel = (v) => `${v >= s.startMs ? '+' : ''}${v - s.startMs}ms`;
      const drift = `\nTiming vs T: fire entered ${rel(tEnter)}` + (sentAts.length ? `, first send ${rel(Math.min(...sentAts))}, last send ${rel(Math.max(...sentAts))}` : ', nothing sent');
      bot.sendMessage(s.chatId, (out.text.slice(0, 3800) + drift));
    } catch (err) {
      bot.sendMessage(s.chatId, `Auto-mint failed: ${err.message.slice(0, 200)}`);
    }
  }

  schedules.init(fireSchedule, prewarmSchedule, refreshSchedule);

  return {
    renderScheduleList, renderScheduleDetail, renderSchdWallets, showScheduleList, showScheduleDetail,
    schUpcomingStages, enterScheduleMenu, stageReasons, enterSchWalletMenu, renderSchElig,
    renderSchSepPage, renderSchSeeAll, askSchQty, schConfirm, matchStage, prewarmSchedule,
    refreshSchedule, fireSchedule,
  };
};

