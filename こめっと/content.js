/* YouTubeの既存コメントを読み取り、タイムコードに同期する弾幕を重ねる。 */
(() => {
  'use strict';
  if (globalThis.__cometInstalled) return;
  globalThis.__cometInstalled = true;
  const C = CometCore;
  const state = { id: '', settings: C.settings(), youtube: new Map(), player: null, video: null, renderer: null, host: null, shadow: null, stale: new Set(), lastStatus: '', collecting: false, apiActive: false, sourceCache: null, timedCount: 0, timedCommentCount: 0, untimedCount: 0, collectionInfo: null };
  let scanTimer;
  let scanDue;
  let lastPublish=0;
  function sources(){return state.sourceCache||(state.sourceCache=[...state.youtube.values()].flat());}
  function clearComments(){state.youtube.clear();state.sourceCache=null;state.timedCount=0;state.timedCommentCount=0;state.untimedCount=0;}
  function addComment(raw){
    const timed=C.parseComment(raw,raw.id),parsed=timed.length?timed:C.untimedComment(raw,raw.id);
    const old=state.youtube.get(raw.id)||[];
    state.timedCommentCount+=Number(parsed.some(e=>!e.untimed))-Number(old.some(e=>!e.untimed));
    state.timedCount+=parsed.filter(e=>!e.untimed).length-old.filter(e=>!e.untimed).length;
    state.untimedCount+=parsed.filter(e=>e.untimed).length-old.filter(e=>e.untimed).length;
    state.youtube.set(raw.id,parsed);state.sourceCache=null;
  }
  function acceptBatch(rows,replace=false){
    if(replace)clearComments();state.apiActive=true;
    for(const row of rows)addComment(row);
    if(performance.now()-lastPublish>1000){lastPublish=performance.now();update();}
  }
  const collector=new CometCommentCollector({
    onBatch:(rows,meta)=>{if(collector.videoId===state.id)acceptBatch(rows,meta.replace);},
    onProgress:info=>{
      if(info.videoId!==state.id)return;
      state.collectionInfo={status:info.status,total:info.total,count:info.count,replies:info.replies,pages:info.pages,pending:info.pending?.length||0,error:info.error||''};
      updateStatus();
    }
  });
  function videoId() {
    if (globalThis.COMET_DEMO) return 'comet-demo';
    return location.pathname === '/watch' ? new URL(location.href).searchParams.get('v') || '' : '';
  }
  function rawComments() {
    const threads = [...document.querySelectorAll('ytd-comment-thread-renderer')];
    const nodes = threads.length ? threads : [...document.querySelectorAll('ytd-comment-view-model, ytd-comment-renderer')].filter(n => !n.closest('#replies'));
    return nodes.flatMap(node => {
      const text = node.querySelector('#content-text')?.innerText || node.querySelector('#content-text')?.textContent;
      if (!text) return [];
      const author = node.querySelector('#author-text')?.textContent.trim() || '';
      const likes = C.parseLikes(node.querySelector('#vote-count-middle')?.textContent);
      const id = String(C.hash(`${author}:${text}`));
      return [{ id, text, author, likes }];
    });
  }
  function events() { return C.timeline(sources(),state.settings,state.video?.duration||Infinity,state.video?.currentTime||0,state.apiActive).filter(e=>e.time>=(state.video?.currentTime||0)-state.settings.duration*2&&e.time<=(state.video?.currentTime||0)+20); }
  function status() {
    const totalLabel=document.querySelector('ytd-comments #count')?.textContent.trim()||'';
    return {ok:!!state.video,enabled:state.settings.enabled,videoId:state.id,total:state.youtube.size,visible:state.renderer?.items.length||0,youtube:state.youtube.size,timed:state.timedCommentCount,untimed:state.untimedCount,withoutBody:state.youtube.size-state.timedCommentCount-state.untimedCount,pageTotal:state.collectionInfo?.total??(totalLabel?C.parseLikes(totalLabel):null),personal:0,scheduled:state.renderer?.items.length||0,collecting:state.collecting,collection:state.collectionInfo,time:state.video?.currentTime||0};
  }
  function update() {
    if (!state.renderer) return;
    state.flowBucket = Math.floor((state.video.currentTime || 0) / 10);
    state.renderer.set(events(), state.settings);
    state.shadow.querySelector('[data-toggle]').setAttribute('aria-pressed', String(state.settings.enabled));
    state.shadow.querySelector('[data-toggle]').textContent = state.settings.enabled ? '✦ YouTubeドパガキ弾幕' : '○ YouTubeドパガキ弾幕';
    state.shadow.querySelector('[data-festival]').setAttribute('aria-pressed', String(state.settings.festival));
    state.shadow.querySelector('[data-festival]').textContent = state.settings.festival ? '🔥 祭りモード' : '☁ まったりモード';
    updateStatus();
  }
  function updateStatus() {
    if (!state.shadow) return;
    const s = status();
    const total = s.pageTotal === null ? 'YouTube全体の件数は未取得' : `${s.collection?.total!==null&&s.collection?.total!==undefined?'取得開始時の参考総数':'YouTube表示総数'} ${s.pageTotal.toLocaleString()} 件`;
    const label = `${total} ／ 読み込み済み ${s.youtube} 件（時刻付き ${s.timed}・時刻なし ${s.untimed}${s.withoutBody?'・本文なし/時刻だけ '+s.withoutBody:''}）`;
    state.shadow.querySelector('[data-count]').textContent = label;
    const info=s.collection;
    const buttonLabel=state.collecting?'■ 一時停止':info&&['paused','failed','running'].includes(info.status)?'▶ 続きから全件取得':info?.status==='exhausted'?'↻ 全件を再取得':'↓ 全件取得（返信込み）';
    state.shadow.querySelector('[data-collect]').textContent=buttonLabel;
    state.shadow.querySelector('[data-quick-collect]').hidden=!state.settings.enabled||info?.status==='exhausted';
    state.shadow.querySelector('[data-quick-collect]').textContent=buttonLabel;
    const progress=state.shadow.querySelector('[data-collection-status]');
    progress.textContent=info?`${({running:'取得中',paused:'一時停止',failed:'取得停止',exhausted:'取得先の末尾まで取得'})[info.status]}：${info.count.toLocaleString()}件（返信${info.replies.toLocaleString()}件）・${info.pages}ページ${info.error?' ／ '+info.error:''}${info.status==='exhausted'&&info.total!==null&&info.count!==info.total?' ／ 表示総数との差 '+Math.abs(info.total-info.count).toLocaleString()+' 件':''}`:'全件取得を押すと、スクロールせずに本文と返信を最後まで取得します';
    state.shadow.querySelector('[data-restart]').hidden=!info||!['paused','failed'].includes(info.status);

  }
  function scan() {
    if (!state.id || !state.renderer || state.apiActive) return;
    const watch = document.querySelector('ytd-watch-flexy');
    if (watch?.getAttribute('video-id') && watch.getAttribute('video-id') !== state.id && !globalThis.COMET_DEMO) return;
    let changed = false;
    for (const raw of rawComments()) {
      if (state.stale.has(raw.id)) continue;
      const timed = C.parseComment(raw, raw.id);
      const parsed = timed.length ? timed : C.untimedComment(raw, raw.id);
      const existing = state.youtube.get(raw.id);
      if (JSON.stringify(existing) !== JSON.stringify(parsed)) { addComment(raw); changed = true; }
    }
    if (changed) update();
  }
  function requestScan() {
    if (scanDue) return;
    scanDue = setTimeout(() => { scanDue = null; scan(); }, 500);
  }
  function toast(text) {
    if (!state.shadow) return;
    const node = state.shadow.querySelector('[data-toast]');
    node.textContent = text; node.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { node.hidden = true; }, 4500);
  }
  async function writeSettings(patch) {
    const data = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: C.settings({ ...data.settings, ...patch }) });
  }
  async function collectComments({restart=false}={}) {
    if(state.collecting){collector.stop();return {ok:true};}
    const id=state.id;
    if(!id||!state.video)return {ok:false,error:'YouTubeの通常動画を開いてください'};
    if(collector.running){collector.stop();await state.activeRun;}
    if(state.id!==id)return {ok:false,error:'動画が切り替わりました'};
    state.collecting=true;updateStatus();
    toast('本文と返信を全件取得します。画面のスクロールは不要です。再度押すと一時停止');
    try {
      state.activeRun=collector.run(id,{restart});const result=await state.activeRun;
      if(state.id===id){
        state.collecting=false;update();
        toast(result.status==='exhausted'?`取得先の末尾まで取得：${result.count.toLocaleString()}件` : result.status==='paused'?'一時停止しました。続きから再開できます':result.error);
      }
      return {ok:result.status!=='failed',status:result.status,error:result.error};
    }catch(error){if(state.id===id){state.collecting=false;toast(error.message);updateStatus();}return {ok:false,error:error.message};}
  }
  function positionControls() {
    if(!state.controlsHost)return;
    const heading=document.querySelector('ytd-watch-metadata h1')||document.querySelector('#above-the-fold h1');
    const row=heading?.parentElement;
    if(!row)return;
    if(state.titleRow!==row){state.titleRow?.classList.remove('comet-title-row');state.titleRow=row;row.classList.add('comet-title-row');}
    if(state.controlsHost.parentElement!==row)row.appendChild(state.controlsHost);
  }
  function mount(player, video) {
    const host=document.createElement('div');host.id='comet-danmaku-root';
    host.style.cssText='position:absolute;inset:0;z-index:35;pointer-events:none;overflow:hidden;';
    const renderShadow=host.attachShadow({mode:'open'});
    renderShadow.innerHTML='<style>canvas.screen{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.corner{position:absolute;right:1px;top:1px;height:18px;padding:0 4px;border:1px solid #ffffff35;border-radius:3px;background:#10121adf;color:#e6e1ec;font:600 10px/16px system-ui,sans-serif;pointer-events:auto;cursor:pointer;box-shadow:none}.corner:hover{background:#242030}.corner:focus-visible{outline:2px solid #85ffdc;outline-offset:-2px}</style><canvas class="screen" aria-hidden="true"></canvas><button class="corner" data-corner aria-label="YouTubeドパガキ弾幕の設定を開く" aria-expanded="false" title="YouTubeドパガキ弾幕の設定">⚙ 弾幕</button>';
    player.appendChild(host);
    const controlsHost=document.createElement('div');controlsHost.id='comet-controls-root';
    const shadow=controlsHost.attachShadow({mode:'open'});
    shadow.innerHTML=`<style>
      :host{display:block;flex:0 1 auto;min-width:0;max-width:100%;color-scheme:dark;color:#faf6ff;font:13px/1.5 system-ui,-apple-system,"Yu Gothic",sans-serif;}
      *{box-sizing:border-box}[hidden]{display:none!important}
      button{font:inherit;cursor:pointer;color:inherit;border:1px solid #ffffff28;background:#241735;border-radius:10px;padding:7px 11px;}
      button:hover{background:#482257;border-color:#ff65be}button:focus-visible{outline:2px solid #85ffdc;outline-offset:3px}
      .toolbar{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;}
      .brand{font-weight:900;white-space:nowrap}[aria-pressed="false"].brand{opacity:.6}
      .panel{width:min(360px,calc(100vw - 32px));max-width:100%;margin:8px 0 0 auto;padding:17px;border:1px solid #bc91ff55;border-radius:17px;background:#170f26;max-height:65vh;overflow:auto;}
      .panel h3{margin:0 0 6px;font-size:18px;font-weight:900}.muted{color:#bcb0d2;font-size:12px;margin:6px 0 12px}
      .stack{display:grid;gap:8px}.stack button{text-align:left}.close{float:right;padding:2px 8px}
      .toast{margin:8px 0 0;padding:8px 12px;border:1px solid #b992ff66;border-radius:10px;background:#1b122c;max-width:420px;font-size:12px;}
      @media(max-width:550px){.toolbar{justify-content:flex-start}button{font-size:11px;padding:6px 9px}.panel{margin-left:0}}
    </style>
    <div class="toolbar"><button data-quick-collect>↓ 全件取得（返信込み）</button><button class="brand" data-toggle aria-pressed="true" title="弾幕のON/OFF">✦ YouTubeドパガキ弾幕</button><button data-panel aria-label="YouTubeドパガキ弾幕の設定を開く" aria-expanded="false">⚙ 設定</button></div>
    <section class="panel" data-panel-body hidden aria-label="YouTubeドパガキ弾幕の設定"><button class="close" data-close aria-label="設定を閉じる">×</button><h3>既存コメントを弾幕に</h3><p class="muted" data-count></p><div class="stack"><button data-festival aria-pressed="true">🔥 祭りモード</button><button data-collect>↓ 全件取得（返信込み）</button><button data-restart hidden>最初から再取得</button><p class="muted" data-collection-status role="status"></p></div><p class="muted">YouTubeの既存コメントを表示。時刻付きはその時刻、時刻なしは取得済み全体から選んで流れます。全件取得で本文と返信を保存し、中断後も再開できます。</p></section>
    <div class="toast" data-toast hidden role="status" aria-live="polite"></div>`;
    const layoutStyle=document.createElement('style');layoutStyle.id='comet-title-layout';
    layoutStyle.textContent='.comet-title-row{display:flex!important;align-items:flex-start;flex-wrap:wrap;gap:8px 12px}.comet-title-row>h1{flex:1 1 260px!important;min-width:0!important}.comet-title-row>#comet-controls-root{flex:0 1 auto;max-width:100%}';
    document.head.appendChild(layoutStyle);
    state.player=player;state.video=video;state.host=host;state.shadow=shadow;state.controlsHost=controlsHost;state.layoutStyle=layoutStyle;
    state.renderer=new CometRenderer(renderShadow.querySelector('.screen'),video);
    positionControls();
    const corner=renderShadow.querySelector('[data-corner]');
    const openPanel = (open) => { shadow.querySelector('[data-panel-body]').hidden = !open; shadow.querySelector('[data-panel]').setAttribute('aria-expanded', String(open)); corner.setAttribute('aria-expanded',String(open)); };
    corner.addEventListener('click',async()=>{
      try{
        if(document.fullscreenElement)await document.exitFullscreen();
        const open=shadow.querySelector('[data-panel-body]').hidden;
        openPanel(open);
        if(open)shadow.querySelector('[data-panel-body]').scrollIntoView({block:'nearest',behavior:'auto'});
      }catch{toast('設定を開けませんでした。全画面を解除してタイトル横の設定を押してください');}
    });
    shadow.querySelector('[data-toggle]').addEventListener('click', () => writeSettings({ enabled: !state.settings.enabled }).catch(() => toast('設定を保存できませんでした')));
    shadow.querySelector('[data-panel]').addEventListener('click', () => openPanel(shadow.querySelector('[data-panel-body]').hidden));
    shadow.querySelector('[data-close]').addEventListener('click', () => openPanel(false));
    shadow.querySelector('[data-festival]').addEventListener('click', () => writeSettings({ festival: !state.settings.festival }).catch(() => toast('設定を保存できませんでした')));
    shadow.querySelector('[data-collect]').addEventListener('click', collectComments);
    shadow.querySelector('[data-quick-collect]').addEventListener('click', collectComments);
    shadow.querySelector('[data-restart]').addEventListener('click',()=>collectComments({restart:true}));
    const meta = () => { update(); };
    video.addEventListener('loadedmetadata', meta);
    video.addEventListener('durationchange', meta);
    video.addEventListener('seeked', meta);
    state.videoCleanup = () => { video.removeEventListener('loadedmetadata', meta); video.removeEventListener('durationchange', meta); video.removeEventListener('seeked', meta); };
    update();
  }
  function unmount() {
    collector.stop();
    state.renderer?.destroy(); state.videoCleanup?.();
    state.host?.remove();state.controlsHost?.remove();state.titleRow?.classList.remove('comet-title-row');state.layoutStyle?.remove();
    state.renderer=null;state.host=null;state.shadow=null;state.video=null;state.player=null;state.controlsHost=null;state.titleRow=null;state.layoutStyle=null;
  }
  async function reconcile() {
    const id = videoId();
    const player = document.getElementById('movie_player');
    const video = player?.querySelector('video');
    if (!id || !player || !video) { if (state.host) unmount(); if (!id) { state.id='';clearComments();state.apiActive=false;state.collectionInfo=null;  } return; }
    if (id !== state.id) {
      collector.stop();
      state.stale=state.id?new Set([...state.youtube.keys(),...rawComments().map(row=>row.id)]):new Set();
      state.id=id;clearComments();state.apiActive=false;state.collectionInfo=null;state.collecting=false;update();
      collector.load(id).then(saved=>{
        if(state.id!==id||state.collecting)return;
        if(saved.comments.length)acceptBatch(saved.comments,true);
        if(saved.job)state.collectionInfo={status:saved.job.status==='running'?'paused':saved.job.status,total:saved.job.total,count:saved.comments.length,replies:saved.job.replies||0,pages:saved.job.pages||0,pending:saved.job.pending?.length||0,error:saved.job.error||''};
        update();
      }).catch(error=>{if(state.id===id)toast(error.message);});

    }
    if (state.player !== player || state.video !== video || !state.host?.isConnected) { unmount(); mount(player, video); }
    positionControls();
    if (state.flowBucket !== Math.floor((video.currentTime || 0) / 10)) update();
    updateStatus(); scan();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) { state.settings = C.settings(changes.settings.newValue); update(); }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'COMET_STATUS') { respond(status()); return; }
    if (message.type === 'COMET_COLLECT') { collectComments({restart:message.restart===true}).then(respond).catch(() => respond({ ok: false })); return true; }
  });
  document.addEventListener('yt-navigate-start', () => { collector.stop(); if(state.host)state.host.style.visibility='hidden';if(state.controlsHost)state.controlsHost.style.visibility='hidden'; });
  document.addEventListener('yt-navigate-finish', () => { reconcile().then(() => { if(state.host)state.host.style.visibility='';if(state.controlsHost)state.controlsHost.style.visibility=''; }); });
  const observer = new MutationObserver(requestScan);
  observer.observe(document.body, { childList: true, subtree: true });
  chrome.storage.local.get('settings').then(data => { state.settings = C.settings(data.settings); reconcile(); }).catch(reconcile);
  scanTimer = setInterval(reconcile, 1200);
  window.addEventListener('pagehide', () => { clearInterval(scanTimer); clearTimeout(scanDue); observer.disconnect(); unmount(); }, { once: true });
  if (globalThis.COMET_DEMO) globalThis.CometDemo = { status, collectComments, reconcile, events, get renderer() { return state.renderer; } };
})();
