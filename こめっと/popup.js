/* 弾幕の設定保存と、開いているYouTube動画のコメント収集。 */
(() => {
  'use strict';
  const C = CometCore;
  let opts = C.settings();
  let tabId;
  let pending = Promise.resolve();
  const $ = id => document.getElementById(id);
  function display() {
    $('enabled').setAttribute('aria-pressed', String(opts.enabled));
    $('festival').setAttribute('aria-pressed', String(opts.festival));
    $('calm').setAttribute('aria-pressed', String(!opts.festival));
    for (const key of ['fontSize', 'lanes', 'duration', 'opacity']) {
      $(key).value = opts[key];
      $(`${key}-value`).textContent = `${opts[key]}${{ fontSize: 'px', lanes: '段', duration: '秒', opacity: '%' }[key]}`;
    }
    for (const key of ['confetti', 'hideChapters', 'includeUntimed']) $(key).checked = opts[key];
    for (const key of ['ngWords', 'minLikes']) $(key).value = opts[key];
  }
  function save(patch) {
    opts = C.settings({ ...opts, ...patch }); display();
    pending = pending.then(async () => {
      const data = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: C.settings({ ...data.settings, ...patch }) });
    }).catch(() => { $('error').textContent = '設定を保存できませんでした。'; $('error').hidden = false; });
  }
  async function updateStatus() {
    if (!tabId) return;
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'COMET_STATUS' });
      if (!res?.ok) throw new Error('not-watch');
      $('status').textContent = `${res.pageTotal === null ? 'YouTube全体の件数は未取得' : `${res.collection?.total!==null&&res.collection?.total!==undefined?'取得開始時の参考総数':'YouTube表示総数'} ${res.pageTotal.toLocaleString()} 件`} ／ 読み込み済み ${res.youtube} 件`;
      $('collect').disabled = false;
      $('collect').textContent=res.collecting?'■ 一時停止':res.collection&&['paused','failed','running'].includes(res.collection.status)?'▶ 続きから全件取得':res.collection?.status==='exhausted'?'↻ 全件を再取得':'↓ 全件取得（返信込み）';
      $('collectionStatus').textContent=res.collection?`${({running:'取得中',paused:'一時停止',failed:'取得停止',exhausted:'取得先の末尾まで取得'})[res.collection.status]}：${res.collection.count.toLocaleString()}件（返信${res.collection.replies.toLocaleString()}件）${res.collection.error?' ／ '+res.collection.error:''}${res.collection.status==='exhausted'&&res.collection.total!==null&&res.collection.count!==res.collection.total?' ／ 表示総数との差 '+Math.abs(res.collection.total-res.collection.count).toLocaleString()+' 件':''}`:'スクロールせずに全コメントと返信を取得・保存します';
      $('restart').hidden=!res.collection||!['paused','failed'].includes(res.collection.status);
    } catch { $('status').textContent = 'YouTubeの通常動画を開いて使ってね'; $('collect').disabled = true; }
  }
  $('enabled').addEventListener('click', () => save({ enabled: !opts.enabled }));
  $('festival').addEventListener('click', () => save({ festival: true }));
  $('calm').addEventListener('click', () => save({ festival: false }));
  for (const key of ['fontSize', 'lanes', 'duration', 'opacity']) $(key).addEventListener('input', () => save({ [key]: Number($(key).value) }));
  for (const key of ['confetti', 'hideChapters', 'includeUntimed']) $(key).addEventListener('change', () => save({ [key]: $(key).checked }));
  $('ngWords').addEventListener('change', () => save({ ngWords: $('ngWords').value }));
  $('minLikes').addEventListener('change', () => save({ minLikes: Number($('minLikes').value) }));
  $('collect').addEventListener('click', async () => {
    if (!tabId) return;
    $('status').textContent='全件取得中。もう一度押すと一時停止します';
    try { await chrome.tabs.sendMessage(tabId,{type:'COMET_COLLECT'}); } catch { $('error').textContent='動画の切り替えなどで接続が切れました。保存した続きから再開できます';$('error').hidden=false; }
    updateStatus();
  });
  $('restart').addEventListener('click',async()=>{if(!tabId)return;try{await chrome.tabs.sendMessage(tabId,{type:'COMET_COLLECT',restart:true});}catch{$('error').textContent='再取得の接続が切れました。動画のページを確認してください';$('error').hidden=false;}updateStatus();});
  const statusTimer=setInterval(updateStatus,1000);window.addEventListener('pagehide',()=>clearInterval(statusTimer),{once:true});
  chrome.storage.local.get('settings').then(data => { opts = C.settings(data.settings); display(); });
  chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => { tabId = tabs[0]?.id; updateStatus(); });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) { opts = C.settings(changes.settings.newValue); display(); updateStatus(); } });
})();
