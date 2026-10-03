/* YouTube自身の設定で固定のコメント取得APIだけを呼ぶ、MAINワールドの橋渡し。 */
(() => {
  'use strict';
  const API = globalThis.CometCommentAPI;
  const requests = new Map();
  const requestType = 'COMET_COMMENT_REQUEST', responseType = 'COMET_COMMENT_RESPONSE';
  const pageFetch = window.fetch.bind(window);
  async function next(query, signal) {
    const get = key => window.ytcfg?.get?.(key);
    const context = get('INNERTUBE_CONTEXT');
    if (!context?.client) throw new Error('YouTubeの準備が終わっていません。ページの読み込み後に再実行してください');
    const url = new URL('/youtubei/v1/next', location.origin);
    url.searchParams.set('prettyPrint', 'false');
    const key = get('INNERTUBE_API_KEY'); if (key) url.searchParams.set('key', key);
    const headers = { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': String(get('INNERTUBE_CONTEXT_CLIENT_NAME') || 1), 'X-Youtube-Client-Version': String(get('INNERTUBE_CONTEXT_CLIENT_VERSION') || context.client.clientVersion) };
    const visitor = context.client.visitorData; if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    const response = await pageFetch(url.href, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ context, ...query }), signal });
    if (!response.ok) throw new Error(`YouTube HTTP ${response.status}。取得を中断しました。保存した続きから再開できます`);
    const data = await response.json();
    if (data.error) throw new Error(`YouTube応答エラー: ${data.error.message || data.error.code}`);
    return data;
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || location.hostname !== 'www.youtube.com') return;
    const request = event.data;
    if (request?.type !== requestType || typeof request.requestId !== 'string' || request.requestId.length > 100) return;
    if (request.operation === 'cancel') { requests.get(request.requestId)?.abort(); return; }
    if (!['start', 'page'].includes(request.operation) || requests.size >= 3 || requests.has(request.requestId)) return;
    if (location.pathname !== '/watch' || request.videoId !== new URL(location.href).searchParams.get('v') || !/^[\w-]{11}$/.test(request.videoId)) return;
    if (request.operation === 'page' && (typeof request.token !== 'string' || request.token.length > 30000)) return;
    const controller = new AbortController(); requests.set(request.requestId, controller);
    (async () => {
      try {
        let result;
        if (request.operation === 'start') {
          const watch = await next({ videoId: request.videoId }, controller.signal);
          const header = await next({ continuation: API.initial(watch) }, controller.signal);
          result = API.header(header);
        } else {
          const data = await next({ continuation: request.token }, controller.signal);
          result = API.page(data, typeof request.parentId === 'string' ? request.parentId : null);
        }
        if (new URL(location.href).searchParams.get('v') !== request.videoId) throw new Error('動画が切り替わったため取得を中断しました');
        window.postMessage({ type: responseType, requestId: request.requestId, videoId: request.videoId, ok: true, result }, location.origin);
      } catch (error) {
        window.postMessage({ type: responseType, requestId: request.requestId, videoId: request.videoId, ok: false, error: error.name === 'AbortError' ? '取得を中断しました' : String(error.message) }, location.origin);
      } finally { requests.delete(request.requestId); }
    })();
  });
})();
